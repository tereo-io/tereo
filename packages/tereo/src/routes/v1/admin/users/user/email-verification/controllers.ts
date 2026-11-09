import { adminVerifySendTarget } from "../../../../../../middleware/rateLimit.js";
import { validateParams } from "../../../../../../utils/validateReq.js";
import { validateUser } from "../../../../../../utils/auth.js";
import db from "../../../../../../utils/db/index.js";
import { UserIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  assertEmailConfigured,
  assertVerifiable,
  issueVerifyLink,
} from "../../../../../../utils/userLinks.js";

/**
 * Emails the user a link confirming their address. The link is never in the
 * response: only the inbox holds it, so the admin cannot confirm for them.
 */
export const sendEmailVerification = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(UserIdParamSchema, req);

  // A refusal that sends nothing must not cost a slot of the limiter.
  assertVerifiable(await db.users.get(id));
  await assertEmailConfigured();
  await adminVerifySendTarget.check(req, id);

  await db.$transaction((tx) =>
    issueVerifyLink(tx, { userId: id, createdBy: auth.userId })
  );

  res.status(202).end();
};
