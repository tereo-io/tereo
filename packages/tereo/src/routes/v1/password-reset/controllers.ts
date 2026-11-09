import { requestPasswordReset } from "../../../utils/passwordReset.js";
import { TooManyRequestsError } from "../../../utils/errors.js";
import { validateBody } from "../../../utils/validateReq.js";
import { RequestPasswordResetSchema } from "./schemas.js";
import { logger } from "../../../utils/logger.js";
import type { Request, Response } from "express";
import {
  passwordResetAddress,
  passwordResetAddressIp,
  passwordResetIp,
} from "../../../middleware/rateLimit.js";

/**
 * Spends the request's slot in each reset limiter: per IP, then per address
 * and IP, then per address, so a source over its own limits spends nothing
 * of the address's allowance. False once one refuses.
 */
const underResetLimits = async (req: Request, email: string) => {
  try {
    await passwordResetIp.check(req);
    await passwordResetAddressIp.check(req, email);
    await passwordResetAddress.check(req, email);
    return true;
  } catch (err) {
    if (!(err instanceof TooManyRequestsError)) throw err;
    return false;
  }
};

/**
 * Always 202 with no body, whether or not the address has an account that can
 * be reset, so the route cannot be used to find out which addresses do.
 */
export const postPasswordReset = async (req: Request, res: Response) => {
  const { email, client_id } = validateBody(RequestPasswordResetSchema, req);
  if (!(await underResetLimits(req, email))) {
    // Silent: a refusal would tell the caller the address was asked for before.
    logger.info("Password reset request over a limit");
    res.status(202).end();
    return;
  }
  // Answered before any work, so neither the status nor the time of the
  // response, nor a failure of the work, depends on the account.
  res.status(202).end();
  void requestPasswordReset({
    email,
    clientId: client_id,
    ip: req.ip,
  }).catch((err) => logger.error({ err }, "Password reset request failed"));
};
