import { validateParams } from "../../../../../../../utils/validateReq.js";
import { NotFoundError } from "../../../../../../../utils/errors.js";
import { logAuditTx } from "../../../../../../../utils/outbox.js";
import { validateUser } from "../../../../../../../utils/auth.js";
import { IdentityInviteParamsSchema } from "./schemas.js";
import db from "../../../../../../../utils/db/index.js";
import type { Request, Response } from "express";

export const withdrawIdentityInvite = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id, providerId } = validateParams(IdentityInviteParamsSchema, req);

  const invite = await db.userIdentities.getInvite(id, providerId);
  if (!invite) throw new NotFoundError("Invite not found");
  const user = await db.users.get(id);

  await db.$transaction(async (tx) => {
    if ((await db.userIdentities.deleteInvite(id, providerId, tx)) === 0) {
      throw new NotFoundError("Invite not found");
    }
    await logAuditTx(tx, {
      auth,
      action: "DELETE",
      entityType: "IdentityInvite",
      entityId: invite.id,
      entityName: user.email,
      metadata: { userId: id, providerId },
    });
  });

  res.status(204).send();
};
