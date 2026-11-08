import { validateUser } from "../../../../utils/auth.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import {
  accountVerifyResendHour,
  accountVerifyResendMinute,
} from "../../../../middleware/rateLimit.js";
import {
  assertEmailConfigured,
  assertVerifiable,
  issueVerifyLink,
} from "../../../../utils/userLinks.js";

/** Emails the caller a link confirming their address. */
export const resendEmailVerification = async (req: Request, res: Response) => {
  const auth = validateUser(req);

  // A refusal that sends nothing must not cost a slot of the limiters.
  assertVerifiable(await db.users.get(auth.userId));
  await assertEmailConfigured();
  await accountVerifyResendMinute.check(req, auth.userId);
  await accountVerifyResendHour.check(req, auth.userId);

  await db.$transaction(async (tx) => {
    assertVerifiable(await db.users.get(auth.userId, tx));
    await issueVerifyLink(tx, { userId: auth.userId, createdBy: auth.userId });
  });

  res.status(202).end();
};
