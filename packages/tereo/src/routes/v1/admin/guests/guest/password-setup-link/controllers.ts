import { getGuest, getManagedGuest } from "../../../../../../utils/guests.js";
import { AppError, ConflictError } from "../../../../../../utils/errors.js";
import { assertMayResetCredentials } from "../../../users/user/guards.js";
import { issuePasswordLink } from "../../../../../../utils/userLinks.js";
import { hasPermission } from "../../../../../../utils/permissions.js";
import { isUsableAccount } from "../../../../../../utils/users.js";
import { validateUser } from "../../../../../../utils/auth.js";
import { IssuePasswordSetupLinkSchema } from "./schemas.js";
import db from "../../../../../../utils/db/index.js";
import { GuestIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";

const guestHasPassword = () =>
  new AppError(
    403,
    "guest_has_password",
    "This guest has set a password; resetting it requires users.write and every permission they hold"
  );

export const issueGuestPasswordSetupLink = async (
  req: Request,
  res: Response
) => {
  const auth = validateUser(req);
  const { id } = validateParams(GuestIdParamSchema, req);
  const { notify } = validateBody(IssuePasswordSetupLinkSchema, req);

  const { url, expiresAt } = await db.$transaction(async (tx) => {
    const before = await getManagedGuest(auth, id, tx);
    // A link for a guest who has a password replaces it, and its URL comes
    // back to the caller: a credential reset, so it needs what an admin
    // credential reset needs. The authority lock that check takes comes
    // before the row lock.
    const resetsPassword = before.passwordHash !== null;
    if (resetsPassword) {
      if (!hasPermission(auth.permissions, "users.write")) {
        throw guestHasPassword();
      }
      await assertMayResetCredentials(auth, id, tx);
    }
    await db.users.lockForSignInChange(id, tx);
    const guest = await getGuest(id, tx);
    // Set since the check above: refused as though it had been there.
    if (guest.passwordHash !== null && !resetsPassword) {
      throw guestHasPassword();
    }
    // A link for an account that cannot sign in would be refused on use.
    if (!isUsableAccount(guest)) {
      throw new ConflictError(
        "This guest is deactivated or expired; extend or reactivate them first",
        "guest_not_usable"
      );
    }
    return issuePasswordLink(tx, {
      userId: id,
      purpose: "setup",
      createdBy: auth.userId,
      notify,
    });
  });
  res.json({ url, expiresAt: expiresAt.toISOString() });
};
