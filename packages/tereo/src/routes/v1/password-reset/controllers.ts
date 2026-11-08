import { passwordResetAddress } from "../../../middleware/rateLimit.js";
import { requestPasswordReset } from "../../../utils/passwordReset.js";
import { TooManyRequestsError } from "../../../utils/errors.js";
import { getIpIdentifier } from "../../../utils/rateLimit.js";
import { validateBody } from "../../../utils/validateReq.js";
import { RequestPasswordResetSchema } from "./schemas.js";
import { logger } from "../../../utils/logger.js";
import type { Request, Response } from "express";

/**
 * Always 202 with no body, whether or not the address has an account that can
 * be reset, so the route cannot be used to find out which addresses do.
 */
export const postPasswordReset = async (req: Request, res: Response) => {
  const { email, client_id } = validateBody(RequestPasswordResetSchema, req);
  try {
    await passwordResetAddress.check(req, email);
  } catch (err) {
    // Silent: a refusal would tell the caller the address was asked for before.
    if (!(err instanceof TooManyRequestsError)) throw err;
    logger.info("Password reset request over the per-address limit");
    res.status(202).end();
    return;
  }
  await requestPasswordReset({
    email,
    clientId: client_id,
    ip: getIpIdentifier(req),
  });
  res.status(202).end();
};
