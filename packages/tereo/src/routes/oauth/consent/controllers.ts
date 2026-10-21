import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { ConsentGetSchema, ConsentSubmitSchema } from "./schemas.js";
import { OAuth2Error } from "../../../utils/errors.js";
import { logger } from "../../../utils/logger.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import {
  authorizationResponseUrl,
  issueAuthorizationCode,
} from "../../../utils/authorization.js";
import {
  clearConsentSessionCookie,
  getConsentSessionFromCookie,
} from "../../../utils/cookies.js";

export const consentGetHandler = async (req: Request, res: Response) => {
  const query = validateQuery(ConsentGetSchema, req);

  try {
    const details = await db.consent.getConsentDetails(query.session);
    // The token travels in the page URL; the user's details go only to the
    // browser that holds its cookie.
    if (getConsentSessionFromCookie(req, details.clientId) !== query.session) {
      throw new Error("Consent session cookie missing or mismatched");
    }
    res.json(details);
  } catch (error) {
    logger.warn({ err: error }, "Failed to get consent details");
    throw new OAuth2Error(
      "invalid_session",
      "Invalid or expired consent session."
    );
  }
};

export const consentPostHandler = async (req: Request, res: Response) => {
  const body = validateBody(ConsentSubmitSchema, req);

  const session = await db.consent.getConsentSession(body.session_token);
  if (!session) {
    throw new OAuth2Error(
      "invalid_session",
      "Consent session not found. Please start again."
    );
  }

  const client = await db.clients.get(session.clientId);
  const sessionCookie = getConsentSessionFromCookie(req, client.clientId);
  if (!sessionCookie || sessionCookie !== body.session_token) {
    throw new OAuth2Error(
      "invalid_session",
      "Invalid or expired session. Please start again."
    );
  }

  if (session.expiresAt < new Date()) {
    await db.consent.deleteConsentSession(session.id);
    clearConsentSessionCookie(res, client.clientId);
    throw new OAuth2Error(
      "session_expired",
      "Session expired. Please start again."
    );
  }

  clearConsentSessionCookie(res, client.clientId);

  if (!body.approved) {
    if (!(await db.consent.consumeConsentSession(session.id))) {
      throw consentSessionGone();
    }
    logger.debug(
      {
        userId: session.userId,
        clientId: session.clientId,
      },
      "User denied consent"
    );

    const redirectUrl = authorizationResponseUrl(session.redirectUri, {
      error: "access_denied",
      error_description: "The user denied the authorization request.",
      state: session.state,
    });

    res.json({ redirect_url: redirectUrl });
    return;
  }

  // Consumed under the user's lock: a password change that deleted it, or a
  // concurrent approval, leaves nothing to issue a code for.
  const redirectUrl = await issueAuthorizationCode(
    req,
    res,
    client,
    session,
    async (tx) => {
      if (!(await db.consent.consumeConsentSession(session.id, tx))) {
        throw consentSessionGone();
      }
    }
  );

  logger.debug(
    {
      userId: session.userId,
      clientId: session.clientId,
      scopes: session.scopes,
    },
    "User approved consent"
  );

  res.json({ redirect_url: redirectUrl });
};

const consentSessionGone = () =>
  new OAuth2Error(
    "invalid_session",
    "Consent session not found. Please start again."
  );
