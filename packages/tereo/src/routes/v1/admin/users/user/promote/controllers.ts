import { assertMayResetCredentials, assertNotSystemUser } from "../guards.js";
import { getGuest, promoteGuest } from "../../../../../../utils/guests.js";
import { formatAdminUser } from "../../../../../../utils/transformers.js";
import { validateParams } from "../../../../../../utils/validateReq.js";
import { validateUser } from "../../../../../../utils/auth.js";
import db from "../../../../../../utils/db/index.js";
import { UserIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  disconnectTokenSockets,
  notifyUserRolesChanged,
} from "../../../../../../websocket/emitters/index.js";

export const promoteUser = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(UserIdParamSchema, req);
  assertNotSystemUser(id);
  await getGuest(id);

  const { user, revokedJtis } = await db.$transaction(
    async (tx) => {
      // The account keeps everything it holds, now with no expiry: the caller
      // must hold all of it, as for a credential reset.
      await assertMayResetCredentials(auth, id, tx);
      return promoteGuest(tx, auth, id);
    },
    { timeout: 30_000 }
  );

  disconnectTokenSockets(revokedJtis);
  notifyUserRolesChanged(id);
  res.json(formatAdminUser(user));
};
