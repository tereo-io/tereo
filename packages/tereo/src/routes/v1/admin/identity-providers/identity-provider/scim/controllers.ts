import { getDefaultOrganizationId } from "../../../../../../utils/defaultOrganization.js";
import type { Prisma } from "../../../../../../../prisma/generated/client/index.js";
import { mapUniqueViolation } from "../../../../../../utils/prismaErrors.js";
import { assertMayGrantScim } from "../../../../../../utils/scim/tokens.js";
import { unlinkScimGroupTx } from "../../../../../../utils/scim/groups.js";
import type { GroupsTarget } from "../../../../../../utils/db/scim.js";
import { scimBaseUrl } from "../../../../../../utils/scim/url.js";
import { logAuditTx } from "../../../../../../utils/outbox.js";
import { validateUser } from "../../../../../../utils/auth.js";
import { IdentityProviderIdParamSchema } from "../schemas.js";
import { PutScimConnectionSchema } from "./schemas.js";
import db from "../../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../../../../../utils/errors.js";

type Tx = Prisma.TransactionClient;

type StoredTarget = {
  groupsTarget: "none" | "global" | "organization";
  groupsOrganizationId: string | null;
};

const toTarget = (c: StoredTarget): GroupsTarget =>
  c.groupsTarget === "organization" && c.groupsOrganizationId
    ? { kind: "organization", organizationId: c.groupsOrganizationId }
    : { kind: c.groupsTarget === "global" ? "global" : "none" };

const sameTarget = (a: GroupsTarget, b: GroupsTarget) =>
  a.kind === b.kind &&
  (a.kind !== "organization" ||
    (b.kind === "organization" && a.organizationId === b.organizationId));

const formatConnection = async (connectionId: string) => {
  const [connection, tokens, managedUserCount, managedGroupCount] =
    await Promise.all([
      db.scim.getConnection(connectionId),
      db.scim.listTokens(connectionId),
      db.scim.countLinks(connectionId),
      db.scimGroups.countLinks(connectionId),
    ]);
  return {
    id: connection.id,
    providerId: connection.providerId,
    baseUrl: scimBaseUrl(),
    isActive: connection.isActive,
    lastUsedAt: connection.lastUsedAt,
    managedUserCount,
    groupsTarget: toTarget(connection),
    managedGroupCount,
    tokens: tokens.map((t) => ({
      id: t.id,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
      revokedAt: t.revokedAt,
    })),
  };
};

export const getScimConnection = async (req: Request, res: Response) => {
  const { id } = validateParams(IdentityProviderIdParamSchema, req);
  const connection = await db.scim.getConnectionByProvider(id);
  if (!connection) throw new NotFoundError("SCIM connection not found");
  res.json(await formatConnection(connection.id));
};

/**
 * Validates a new target under the connection lock: the organization must be
 * live, and linked groups pin the target to their own scope (or `none`).
 */
const checkTarget = async (
  target: GroupsTarget,
  connectionId: string,
  tx: Tx
) => {
  if (target.kind === "organization") {
    const organization = await db.organizations
      .getAny(target.organizationId, tx)
      .catch((err) => {
        if (err instanceof NotFoundError) return null;
        throw err;
      });
    if (!organization || organization.archivedAt) {
      throw new BadRequestError(
        "unknown_organization",
        "Unknown or archived organization"
      );
    }
  }
  if (target.kind === "none") return;
  const scope = await db.scimGroups.linkedScope(connectionId, tx);
  if (!scope) return;
  const sameScope =
    target.kind === "organization"
      ? scope.organizationId === target.organizationId
      : scope.organizationId === null;
  if (!sameScope) {
    throw new ConflictError(
      "The connection has linked groups in another scope; unlink them first",
      "scim_groups_exist"
    );
  }
};

export const putScimConnection = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id: providerId } = validateParams(IdentityProviderIdParamSchema, req);
  const { isActive, groupsTarget } = validateBody(PutScimConnectionSchema, req);

  const { connectionId, created } = await db.$transaction(async (tx) => {
    const provider = await db.identityProviders.lockForUpdate(providerId, tx);
    const existing = await db.scim.getConnectionByProvider(providerId, tx);

    if (!existing) {
      if (isActive === undefined) {
        throw new ValidationError(
          "isActive is required to create a connection",
          [{ path: "isActive", message: "Required" }]
        );
      }
      await assertMayGrantScim(auth, tx);
      const row = await mapUniqueViolation(
        () =>
          db.scim.createConnection({ providerId, createdBy: auth.userId }, tx),
        "This provider already has a SCIM connection",
        "scim_connection_exists"
      );
      if (!isActive) await db.scim.setConnectionActive(row.id, false, tx);
      if (groupsTarget && groupsTarget.kind !== "none") {
        await checkTarget(groupsTarget, row.id, tx);
        await db.scim.setGroupsTarget(row.id, groupsTarget, tx);
      }
      await logAuditTx(tx, {
        auth,
        organizationId: getDefaultOrganizationId(),
        action: "CREATE",
        entityType: "ScimConnection",
        entityId: row.id,
        entityName: provider.displayName,
        metadata: { providerId, isActive },
        ...(groupsTarget &&
          groupsTarget.kind !== "none" && {
            changes: {
              groupsTarget: { old: { kind: "none" }, new: groupsTarget },
            },
          }),
      });
      return { connectionId: row.id, created: true };
    }

    // The row lock comes before any group or authority lock; SCIM group
    // writers take it first and re-read the target under it.
    const locked = await db.scim.lockConnection(existing.id, tx);
    const oldTarget = toTarget(locked);
    const targetChanged =
      groupsTarget !== undefined && !sameTarget(oldTarget, groupsTarget);
    const activeChanged =
      isActive !== undefined && locked.isActive !== isActive;

    if (activeChanged && isActive) await assertMayGrantScim(auth, tx);
    if (targetChanged) {
      await assertMayGrantScim(auth, tx);
      await checkTarget(groupsTarget, existing.id, tx);
    }
    if (!activeChanged && !targetChanged) {
      return { connectionId: existing.id, created: false };
    }
    if (activeChanged) {
      await db.scim.setConnectionActive(existing.id, isActive, tx);
    }
    if (targetChanged) {
      await db.scim.setGroupsTarget(existing.id, groupsTarget, tx);
    }
    await logAuditTx(tx, {
      auth,
      organizationId: getDefaultOrganizationId(),
      action: "UPDATE",
      entityType: "ScimConnection",
      entityId: existing.id,
      entityName: provider.displayName,
      changes: {
        ...(activeChanged && {
          isActive: { old: locked.isActive, new: isActive },
        }),
        ...(targetChanged && {
          groupsTarget: { old: oldTarget, new: groupsTarget },
        }),
      },
      metadata: { providerId },
    });
    return { connectionId: existing.id, created: false };
  });

  res.status(created ? 201 : 200).json(await formatConnection(connectionId));
};

export const deleteScimConnection = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id: providerId } = validateParams(IdentityProviderIdParamSchema, req);

  await db.$transaction(async (tx) => {
    const provider = await db.identityProviders.lockForUpdate(providerId, tx);
    const existing = await db.scim.getConnectionByProvider(providerId, tx);
    if (!existing) throw new NotFoundError("SCIM connection not found");
    await db.scim.lockConnection(existing.id, tx);
    if ((await db.scim.countLinks(existing.id, tx)) > 0) {
      throw new ConflictError(
        "The connection still manages users; unlink them first",
        "scim_users_exist"
      );
    }
    // A SCIM group delete takes no connection lock and can unlink a group
    // while this waits on its row; no link can be added under the connection
    // lock, so the re-read lists exactly the groups still linked.
    await db.groups.lockGroups(
      await db.scimGroups.listGroupIds(existing.id, tx),
      tx
    );
    const groupIds = await db.scimGroups.listGroupIds(existing.id, tx);
    for (const groupId of groupIds) {
      await unlinkScimGroupTx(tx, auth, groupId, "connection_deleted");
    }
    // Unlinked users' exclusions go with the connection.
    await db.scim.deleteUnlinked(existing.id, tx);
    await db.scim.deleteConnection(existing.id, tx);
    await logAuditTx(tx, {
      auth,
      organizationId: getDefaultOrganizationId(),
      action: "DELETE",
      entityType: "ScimConnection",
      entityId: existing.id,
      entityName: provider.displayName,
      metadata: { providerId },
    });
  });

  res.status(204).send();
};
