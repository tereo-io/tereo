import { issuePasswordSetupLink } from "../../../../../../utils/passwordSetup.js";
import { isUsableAccount } from "../../../../../../utils/users.js";
import { ConflictError } from "../../../../../../utils/errors.js";
import { validateUser } from "../../../../../../utils/auth.js";
import { IssuePasswordSetupLinkSchema } from "./schemas.js";
import db from "../../../../../../utils/db/index.js";
import { GuestIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";
import {
  assertMayManageGuestsIn,
  getGuest,
  guestOrganizationId,
} from "../../../../../../utils/guests.js";

export const issueGuestPasswordSetupLink = async (
  req: Request,
  res: Response
) => {
  const auth = validateUser(req);
  const { id } = validateParams(GuestIdParamSchema, req);
  const { notify } = validateBody(IssuePasswordSetupLinkSchema, req);

  const { url, expiresAt } = await db.$transaction(async (tx) => {
    await db.users.lockForSignInChange(id, tx);
    const guest = await getGuest(id, tx);
    await assertMayManageGuestsIn(auth, await guestOrganizationId(id, tx));
    // A link for an account that cannot sign in would be refused on use.
    if (!isUsableAccount(guest)) {
      throw new ConflictError(
        "This guest is deactivated or expired; extend or reactivate them first",
        "guest_not_usable"
      );
    }
    return issuePasswordSetupLink(tx, {
      userId: id,
      createdBy: auth.userId,
      notify,
    });
  });
  res.json({ url, expiresAt: expiresAt.toISOString() });
};
