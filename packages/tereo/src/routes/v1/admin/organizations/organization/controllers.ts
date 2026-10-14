import { getDefaultOrganizationId } from "../../../../../utils/defaultOrganization.js";
import { formatOrganization } from "../../../../../utils/transformers.js";
import { requireOrgRole } from "../../../../../utils/orgRoleAuth.js";
import { hasPermission } from "../../../../../utils/permissions.js";
import type { Prisma } from "../../../../../utils/db/prisma.js";
import { validateUser } from "../../../../../utils/auth.js";
import { UpdateOrganizationSchema } from "./schemas.js";
import { logger } from "../../../../../utils/logger.js";
import db from "../../../../../utils/db/index.js";
import { OrgIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  disconnectOrganizationSockets,
  notifyOrgDeactivated,
  notifySessionsRevoked,
} from "../../../../../websocket/emitters/index.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
} from "../../../../../utils/errors.js";
import {
  logAuditTx,
  computeChanges,
  emitTx,
} from "../../../../../utils/outbox.js";

export const getOrganization = async (req: Request, res: Response) => {
  const params = validateParams(OrgIdParamSchema, req);
  await requireOrgRole("member", req, params.id);
  // getAny: archived organizations stay viewable (read-only) by their
  // members and platform admins.
  const org = await db.organizations.getAny(params.id);
  res.json(formatOrganization(org));
};

export const updateOrganization = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(OrgIdParamSchema, req);
  await requireOrgRole("owner", req, params.id);
  const body = validateBody(UpdateOrganizationSchema, req);

  const existing = await db.organizations.get(params.id);
  // Whether an organization is active is the platform's call, not its
  // owners': an owner could otherwise undo a deactivation.
  if (
    body.isActive !== undefined &&
    body.isActive !== existing.isActive &&
    !hasPermission(auth.permissions, "organizations.write")
  ) {
    throw new ForbiddenError(
      "Only organizations.write can activate or deactivate an organization"
    );
  }
  if (body.isActive === false && existing.isDefault) {
    throw new BadRequestError(
      "default_organization",
      "The default organization cannot be deactivated"
    );
  }

  if (body.slug) {
    const conflict = await db.organizations.getBySlugAny(body.slug);
    if (conflict && conflict.id !== params.id) {
      throw new ConflictError(
        conflict.archivedAt
          ? "An archived organization with this slug already exists"
          : "Organization with this slug already exists"
      );
    }
  }

  const deactivating = body.isActive === false && existing.isActive;
  const { org, revoked } = await db.$transaction(async (tx) => {
    const updated = await db.organizations.update(params.id, body, tx);
    await logAuditTx(tx, {
      auth,
      organizationId: updated.id,
      action: "UPDATE",
      entityType: "Organization",
      entityId: updated.id,
      entityName: updated.name,
      changes: computeChanges(existing, updated),
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.organization.updated",
      entityType: "Organization",
      entityId: updated.id,
      data: formatOrganization(updated) as Record<string, unknown>,
    });
    const revoked = deactivating
      ? await revokeOrgTokensAndSessions(params.id, tx)
      : null;
    return { org: updated, revoked };
  });

  if (revoked) await notifyOrgTokensRevoked(params.id, revoked);

  res.json(formatOrganization(org));
};

export const archiveOrganization = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(OrgIdParamSchema, req);

  await db.$transaction(async (tx) => {
    const archived = await db.organizations.archive(params.id, tx);
    await logAuditTx(tx, {
      auth,
      organizationId: archived.id,
      action: "ARCHIVE",
      entityType: "Organization",
      entityId: archived.id,
      entityName: archived.name,
      metadata: { slug: archived.slug },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.organization.archived",
      entityType: "Organization",
      entityId: archived.id,
      data: formatOrganization(archived) as Record<string, unknown>,
    });
  });

  // No token revocation here: archive requires the org to already be
  // deactivated, and deactivation (PATCH isActive=false) revoked them.
  res.status(204).send();
};

export const restoreOrganization = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(OrgIdParamSchema, req);

  const restored = await db.$transaction(async (tx) => {
    const result = await db.organizations.restore(params.id, tx);
    await logAuditTx(tx, {
      auth,
      organizationId: result.id,
      action: "RESTORE",
      entityType: "Organization",
      entityId: result.id,
      entityName: result.name,
      metadata: { slug: result.slug },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.organization.restored",
      entityType: "Organization",
      entityId: result.id,
      data: formatOrganization(result) as Record<string, unknown>,
    });
    return result;
  });

  res.json(formatOrganization(restored));
};

interface RevokedOrgTokens {
  refreshTokens: { id: string; userId: string }[];
  accessTokens: number;
  sessions: number;
}

/**
 * Revokes every token and SSO session issued under the organization, in the
 * deactivating transaction. The users are locked first, as for any session
 * end, and the revocation is by organization rather than by a list read
 * beforehand: a refresh in flight either finishes first and its successor is
 * revoked here, or waits and finds its token spent.
 */
async function revokeOrgTokensAndSessions(
  orgId: string,
  tx: Prisma.TransactionClient
): Promise<RevokedOrgTokens> {
  await db.users.lockForSessionEnd(tx, { organizationIds: [orgId] });
  const refreshTokens = await db.refreshTokens.revokeByOrganizationId(
    orgId,
    tx
  );
  const accessTokens = await db.accessTokens.revokeByOrganizationId(orgId, tx);
  const sessions = await db.userSessions.deleteByOrganizationId(orgId, tx);
  return { refreshTokens, accessTokens: accessTokens.length, sessions };
}

async function notifyOrgTokensRevoked(
  orgId: string,
  { refreshTokens, accessTokens, sessions }: RevokedOrgTokens
): Promise<void> {
  // After the revocation, so the refresh it prompts fails; before the
  // sockets close, so they receive it.
  await notifyOrgDeactivated(orgId);

  // Clients know their session by its refresh token id.
  const sessionsByUser = new Map<string, string[]>();
  for (const { id, userId } of refreshTokens) {
    sessionsByUser.set(userId, [...(sessionsByUser.get(userId) ?? []), id]);
  }
  for (const [userId, sessionIds] of sessionsByUser) {
    notifySessionsRevoked(userId, sessionIds);
  }
  // Tokens issued for the org without a session have no session room.
  disconnectOrganizationSockets(orgId);

  logger.info(
    { orgId, refreshTokens: refreshTokens.length, accessTokens, sessions },
    "Revoked org tokens and sessions"
  );
}
