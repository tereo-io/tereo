import { getDefaultOrganizationId } from "../../../../../../utils/defaultOrganization.js";
import { mapUniqueViolation } from "../../../../../../utils/prismaErrors.js";
import { assertMayGrantScim } from "../../../../../../utils/scim/tokens.js";
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
  ConflictError,
  NotFoundError,
} from "../../../../../../utils/errors.js";

const formatConnection = async (connectionId: string) => {
  const [connection, tokens, managedUserCount] = await Promise.all([
    db.scim.getConnection(connectionId),
    db.scim.listTokens(connectionId),
    db.scim.countLinks(connectionId),
  ]);
  return {
    id: connection.id,
    providerId: connection.providerId,
    baseUrl: scimBaseUrl(),
    isActive: connection.isActive,
    lastUsedAt: connection.lastUsedAt,
    managedUserCount,
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

export const putScimConnection = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id: providerId } = validateParams(IdentityProviderIdParamSchema, req);
  const { isActive } = validateBody(PutScimConnectionSchema, req);

  const { connectionId, created } = await db.$transaction(async (tx) => {
    const provider = await db.identityProviders.lockForUpdate(providerId, tx);
    const existing = await db.scim.getConnectionByProvider(providerId, tx);

    if (!existing) {
      await assertMayGrantScim(auth, tx);
      const row = await mapUniqueViolation(
        () =>
          db.scim.createConnection({ providerId, createdBy: auth.userId }, tx),
        "This provider already has a SCIM connection",
        "scim_connection_exists"
      );
      if (!isActive) await db.scim.setConnectionActive(row.id, false, tx);
      await logAuditTx(tx, {
        auth,
        organizationId: getDefaultOrganizationId(),
        action: "CREATE",
        entityType: "ScimConnection",
        entityId: row.id,
        entityName: provider.displayName,
        metadata: { providerId, isActive },
      });
      return { connectionId: row.id, created: true };
    }

    if (existing.isActive !== isActive) {
      if (isActive) await assertMayGrantScim(auth, tx);
      await db.scim.setConnectionActive(existing.id, isActive, tx);
      await logAuditTx(tx, {
        auth,
        organizationId: getDefaultOrganizationId(),
        action: "UPDATE",
        entityType: "ScimConnection",
        entityId: existing.id,
        entityName: provider.displayName,
        changes: { isActive: { old: existing.isActive, new: isActive } },
        metadata: { providerId },
      });
    }
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
