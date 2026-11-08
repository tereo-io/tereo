import { validateParams } from "../../../../../../utils/validateReq.js";
import { issueVerifyLink } from "../../../../../../utils/userLinks.js";
import { validateUser } from "../../../../../../utils/auth.js";
import db from "../../../../../../utils/db/index.js";
import { UserIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";

/**
 * Emails the user a link confirming their address. The link is never in the
 * response: only the inbox holds it, so the admin cannot confirm for them.
 */
export const sendEmailVerification = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(UserIdParamSchema, req);

  await db.$transaction((tx) =>
    issueVerifyLink(tx, { userId: id, createdBy: auth.userId })
  );

  res.status(202).end();
};
