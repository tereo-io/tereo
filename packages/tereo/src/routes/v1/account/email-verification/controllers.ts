import { issueVerifyLink } from "../../../../utils/userLinks.js";
import { ConflictError } from "../../../../utils/errors.js";
import { validateUser } from "../../../../utils/auth.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import {
  accountVerifyResendHour,
  accountVerifyResendMinute,
} from "../../../../middleware/rateLimit.js";

/** Emails the caller a link confirming their address. */
export const resendEmailVerification = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  await accountVerifyResendMinute.check(req, auth.userId);
  await accountVerifyResendHour.check(req, auth.userId);

  await db.$transaction(async (tx) => {
    const user = await db.users.get(auth.userId, tx);
    if (user.emailVerifiedAt) {
      throw new ConflictError(
        "The email address is already verified",
        "already_verified"
      );
    }
    await issueVerifyLink(tx, { userId: user.id, createdBy: user.id });
  });

  res.status(202).end();
};
