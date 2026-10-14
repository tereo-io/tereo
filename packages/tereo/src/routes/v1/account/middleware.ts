import { AppError, ForbiddenError } from "../../../utils/errors.js";
import { isFirstPartyClient } from "../../../definitions/index.js";
import type { NextFunction, Request, Response } from "express";
import { validateUser } from "../../../utils/auth.js";

const RECENT_LOGIN_SECONDS = 600;

/**
 * Refuses unless the token's login is under 10 minutes old: a stolen session
 * must not be able to add or remove a way into the account, or put a second
 * factor of its own in front of it.
 */
export const requireRecentLogin = (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  const { authTime } = validateUser(req);
  if (
    !authTime ||
    Date.now() - authTime.getTime() > RECENT_LOGIN_SECONDS * 1000
  ) {
    throw new AppError(
      403,
      "reauth_required",
      "Sign in again to change how you sign in"
    );
  }
  next();
};

/**
 * Refuses a token issued to any client but core's own UI. A third-party
 * client holding core:account could otherwise start a link itself, keep the
 * upstream cookie, and connect its own provider account to the user, or
 * enroll its own authenticator and lock the user out.
 */
export const requireCoreUi = (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  const { clientId } = validateUser(req);
  if (!isFirstPartyClient(clientId)) {
    throw new ForbiddenError(
      "Changing how you sign in is only possible in core's own UI"
    );
  }
  next();
};
