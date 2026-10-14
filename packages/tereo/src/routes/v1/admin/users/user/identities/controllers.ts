import { formatUserIdentity } from "../../../../../../utils/identityProviders/identities.js";
import { validateParams } from "../../../../../../utils/validateReq.js";
import db from "../../../../../../utils/db/index.js";
import { UserIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";

export const listUserIdentities = async (req: Request, res: Response) => {
  const { id } = validateParams(UserIdParamSchema, req);
  await db.users.get(id);
  const identities = await db.userIdentities.listForUser(id);
  const invites = await db.userIdentities.listInvites(id);
  res.json({
    identities: identities.map(formatUserIdentity),
    invites: invites.map((invite) => ({
      provider: {
        id: invite.provider.id,
        slug: invite.provider.slug,
        displayName: invite.provider.displayName,
      },
      expiresAt: invite.expiresAt.toISOString(),
    })),
  });
};
