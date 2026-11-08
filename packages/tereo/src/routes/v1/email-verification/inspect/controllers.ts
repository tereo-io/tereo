import { emailVerificationFailure } from "../../../../middleware/rateLimit.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { EmailVerificationTokenSchema } from "../schemas.js";
import { findUsableVerifyToken } from "../controllers.js";
import type { Request, Response } from "express";

/** The address a verify link confirms and when it expires. Consumes nothing. */
export const inspectEmailVerification = async (req: Request, res: Response) => {
  const { token } = validateBody(EmailVerificationTokenSchema, req);
  await emailVerificationFailure.assertUnderLimit(req);
  const { user, expiresAt } = await findUsableVerifyToken(req, token);
  res.json({ email: user.email, expiresAt: expiresAt.toISOString() });
};
