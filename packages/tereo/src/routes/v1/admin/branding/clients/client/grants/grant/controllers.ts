import { getDefaultOrganizationId } from "../../../../../../../../utils/defaultOrganization.js";
import { assertMayManageGrants } from "../../../../../../../../utils/branding/access.js";
import { validateParams } from "../../../../../../../../utils/validateReq.js";
import { emitTx, logAuditTx } from "../../../../../../../../utils/outbox.js";
import { NotFoundError } from "../../../../../../../../utils/errors.js";
import { validateUser } from "../../../../../../../../utils/auth.js";
import db from "../../../../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import { GrantParamsSchema } from "./schemas.js";

export const revokeGrant = async (req: Request, res: Response) => {
  const user = validateUser(req);
  const { id, userId } = validateParams(GrantParamsSchema, req);
  const client = await db.clients.get(id);
  assertMayManageGrants(user, client);

  await db.$transaction(async (tx) => {
    const grant = await db.brandingGrants.getActive(client.id, userId, tx);
    if (
      !grant ||
      !(await db.brandingGrants.revoke(client.id, userId, user.userId, tx))
    ) {
      throw new NotFoundError("No active grant for this user");
    }
    await logAuditTx(tx, {
      auth: user,
      action: "DELETE",
      entityType: "BrandingGrant",
      entityId: grant.id,
      entityName: client.clientId,
      metadata: { clientId: client.clientId, userId },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.branding.grant-revoked",
      entityType: "BrandingGrant",
      entityId: grant.id,
      data: { clientId: client.clientId, userId, revokedBy: user.userId },
    });
  });
  res.status(204).send();
};
