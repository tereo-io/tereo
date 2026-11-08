import { emailVerificationFailure } from "../../../middleware/rateLimit.js";
import { markEmailVerified } from "../../../utils/userLinks.js";
import { validateBody } from "../../../utils/validateReq.js";
import { EmailVerificationTokenSchema } from "./schemas.js";
import { isUsableAccount } from "../../../utils/users.js";
import { hashFlowToken } from "../../../utils/crypto.js";
import { NotFoundError } from "../../../utils/errors.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";

/**
 * The live verify link and its user, or the one 404 every miss gets: unknown,
 * used or expired token, a user who cannot sign in, and a link for an address
 * the user has since left. A miss counts against the caller's IP.
 */
export const findUsableVerifyToken = async (req: Request, token: string) => {
  const found = await db.userLinkTokens.findLiveByHash(hashFlowToken(token), [
    "verify",
  ]);
  if (
    !found ||
    !isUsableAccount(found.user) ||
    found.user.email !== found.email
  ) {
    await emailVerificationFailure.recordFailure(req);
    throw new NotFoundError("Not found");
  }
  return found;
};

/**
 * Confirms the address from a verify link. Ends no session: nothing about the
 * credentials changed. The token is consumed with a conditional update, so of
 * two concurrent requests with one token exactly one wins.
 */
export const verifyEmail = async (req: Request, res: Response) => {
  const { token } = validateBody(EmailVerificationTokenSchema, req);
  await emailVerificationFailure.assertUnderLimit(req);
  const { id: tokenId, user } = await findUsableVerifyToken(req, token);

  await db.$transaction(async (tx) => {
    // Locked: a deactivation or an email change since the lookup shows here.
    await tx.$executeRaw`
      SELECT 1 FROM "auth"."users" WHERE "id" = ${user.id}::uuid FOR UPDATE`;
    const current = await db.users.get(user.id, tx);
    if (
      !isUsableAccount(current) ||
      current.email !== user.email ||
      !(await db.userLinkTokens.consume(tokenId, tx))
    ) {
      await emailVerificationFailure.recordFailure(req);
      throw new NotFoundError("Not found");
    }
    await markEmailVerified(tx, { userId: user.id, via: "link" });
  });

  res.status(204).end();
};
