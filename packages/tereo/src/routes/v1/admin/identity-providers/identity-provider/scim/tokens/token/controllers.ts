import { getDefaultOrganizationId } from "../../../../../../../../utils/defaultOrganization.js";
import { validateParams } from "../../../../../../../../utils/validateReq.js";
import { NotFoundError } from "../../../../../../../../utils/errors.js";
import { logAuditTx } from "../../../../../../../../utils/outbox.js";
import { validateUser } from "../../../../../../../../utils/auth.js";
import db from "../../../../../../../../utils/db/index.js";
import { ScimTokenParamsSchema } from "./schemas.js";
import type { Request, Response } from "express";

export const revokeScimToken = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id: providerId, tokenId } = validateParams(
    ScimTokenParamsSchema,
    req
  );
  const connection = await db.scim.getConnectionByProvider(providerId);
  if (!connection) throw new NotFoundError("SCIM connection not found");

  await db.$transaction(async (tx) => {
    const revoked = await db.scim.revokeToken(connection.id, tokenId, tx);
    if (!revoked) throw new NotFoundError("SCIM token not found");
    await logAuditTx(tx, {
      auth,
      organizationId: getDefaultOrganizationId(),
      action: "DELETE",
      entityType: "ScimToken",
      entityId: tokenId,
      entityName: "SCIM token",
      metadata: { providerId, connectionId: connection.id },
    });
  });

  res.status(204).send();
};
