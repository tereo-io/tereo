import { validateUser } from "../../../../utils/auth.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import {
  CONSOLE_CLIENT_ID,
  isBrandingAdmin,
} from "../../../../utils/branding/access.js";

/** The default (branding.admin only) and the branded clients the caller may read. */
export const listBranding = async (req: Request, res: Response) => {
  const user = validateUser(req);
  const admin = isBrandingAdmin(user);
  const [defaultProfile, profiles] = await Promise.all([
    admin ? db.brandingProfiles.getDefault() : null,
    db.brandingProfiles.listClientProfiles(
      admin
        ? { all: true }
        : { readableBy: user.userId, excludeClientId: CONSOLE_CLIENT_ID }
    ),
  ]);
  res.json({
    default: defaultProfile && {
      provisioned: defaultProfile.provisioned,
      updatedAt: defaultProfile.updatedAt,
    },
    clients: profiles.flatMap(({ client, provisioned, updatedAt }) =>
      client
        ? [
            {
              id: client.id,
              clientId: client.clientId,
              name: client.name,
              provisioned,
              updatedAt,
            },
          ]
        : []
    ),
  });
};
