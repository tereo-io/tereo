import { UserType } from "../../../../../../../prisma/generated/client/index.js";
import { validateParams } from "../../../../../../utils/validateReq.js";
import { SYSTEM_USER_ID } from "../../../../../../definitions/index.js";
import { issueVerifyLink } from "../../../../../../utils/userLinks.js";
import { ConflictError } from "../../../../../../utils/errors.js";
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

  await db.$transaction(async (tx) => {
    const user = await db.users.get(id, tx);
    if (
      user.id === SYSTEM_USER_ID ||
      user.userType === UserType.service_account ||
      !user.isActive
    ) {
      throw new ConflictError(
        "This account has no address to verify",
        "user_not_verifiable"
      );
    }
    if (user.emailVerifiedAt) {
      throw new ConflictError(
        "The email address is already verified",
        "already_verified"
      );
    }
    await issueVerifyLink(tx, { userId: user.id, createdBy: auth.userId });
  });

  res.status(202).end();
};
