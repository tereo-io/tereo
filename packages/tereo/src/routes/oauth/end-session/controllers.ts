import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { clientSignInUrl, uiUrl } from "../../../utils/authorization.js";
import { NotFoundError, OAuth2Error } from "../../../utils/errors.js";
import type { ClientRecord } from "../../../utils/db/clients.js";
import { generateRandomString } from "../../../utils/crypto.js";
import { endBrowserSessions } from "../../../utils/sessions.js";
import type { IdTokenPayload } from "../../../utils/tokens.js";
import { verifyIdTokenHint } from "../../../utils/tokens.js";
import { logAuditTx } from "../../../utils/outbox.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import { timingSafeEqual } from "crypto";
import {
  clearAuthCookies,
  clearAllSessionCookies,
  setLogoutConfirmCookie,
  getUserSessionFromCookie,
  getRefreshTokenFromCookie,
  getLogoutConfirmFromCookie,
} from "../../../utils/cookies.js";
import {
  EndSessionConfirmGetSchema,
  EndSessionConfirmSchema,
  EndSessionRequestSchema,
} from "./schemas.js";

const findClient = async (clientId: string): Promise<ClientRecord | null> => {
  try {
    return await db.clients.getByClientId(clientId);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
};

const checkPostLogoutRedirectUri = (
  client: ClientRecord,
  uri: string | undefined
) => {
  if (uri && !client.postLogoutRedirectUris.includes(uri)) {
    throw new OAuth2Error(
      "invalid_request",
      "post_logout_redirect_uri is not registered for this client"
    );
  }
};

const postLogoutRedirect = (uri: string | undefined, state?: string) => {
  if (!uri) return null;
  const url = new URL(uri);
  if (state) url.searchParams.set("state", state);
  return url.toString();
};

export const endSessionGetHandler = async (req: Request, res: Response) => {
  await handleEndSession(req, res, "query");
};

export const endSessionPostHandler = async (req: Request, res: Response) => {
  await handleEndSession(req, res, "body");
};

/**
 * RP-initiated logout for this browser only. A request with a valid
 * `id_token_hint` ends the session at once; without one nothing shows the
 * client asked for it — any site can send the browser here — so the browser
 * goes to the UI's confirmation page instead, and only
 * POST /oauth/end-session/confirm ends the session.
 */
const handleEndSession = async (
  req: Request,
  res: Response,
  source: "query" | "body"
) => {
  const params =
    source === "query"
      ? validateQuery(EndSessionRequestSchema, req)
      : validateBody(EndSessionRequestSchema, req);

  if (!params.id_token_hint && !params.client_id) {
    throw new OAuth2Error(
      "invalid_request",
      params.post_logout_redirect_uri
        ? "post_logout_redirect_uri requires client_id or id_token_hint"
        : "client_id or id_token_hint is required"
    );
  }

  const verified = params.id_token_hint
    ? verifyIdTokenHint(params.id_token_hint)
    : null;
  if (params.id_token_hint) {
    if (!verified) {
      throw new OAuth2Error("invalid_request", "Invalid id_token_hint");
    }
    if (params.client_id && params.client_id !== verified.payload.aud) {
      throw new OAuth2Error(
        "invalid_request",
        "client_id does not match the id_token_hint audience"
      );
    }
  }
  // A hint expired past the grace still names its client; otherwise it is
  // treated as none, so the user is asked to confirm.
  const hint = verified && !verified.stale ? verified.payload : null;

  const client = await findClient(verified?.payload.aud ?? params.client_id!);
  if (!client) {
    throw new OAuth2Error(
      "invalid_request",
      verified ? "Invalid id_token_hint: unknown audience" : "Invalid client_id"
    );
  }

  checkPostLogoutRedirectUri(client, params.post_logout_redirect_uri);

  // Any site can hold an ID token of its own user for the client; it shows
  // nothing about a browser signed in as someone else, so that browser is
  // asked to confirm as without a hint.
  if (!hint || (await signedInAsOther(req, client, hint.sub))) {
    const confirmToken = generateRandomString(32);
    setLogoutConfirmCookie(res, confirmToken, client.clientId);
    res.redirect(
      uiUrl("/logout", {
        client_id: client.clientId,
        confirm_token: confirmToken,
        ...(params.post_logout_redirect_uri && {
          post_logout_redirect_uri: params.post_logout_redirect_uri,
        }),
        ...(params.state && { state: params.state }),
      })
    );
    return;
  }

  await endThisBrowser(req, res, client, hint, "id_token_hint");

  const redirectUrl = postLogoutRedirect(
    params.post_logout_redirect_uri,
    params.state
  );
  if (redirectUrl) res.redirect(redirectUrl);
  // A navigation lands where the user signs in again; a fetch (the admin UI
  // signing out) gets JSON.
  else if (source === "query" || req.headers["sec-fetch-mode"] === "navigate") {
    res.redirect(clientSignInUrl(client));
  } else res.json({ success: true });
};

/** Whether this browser's SSO or refresh cookie belongs to another user. */
const signedInAsOther = async (
  req: Request,
  client: ClientRecord,
  userId: string
): Promise<boolean> => {
  const ssoToken = getUserSessionFromCookie(req, client.clientId);
  if (ssoToken) {
    const session = await db.userSessions.getUserSessionByToken(ssoToken);
    if (session && session.userId !== userId) return true;
  }
  const refreshTokenValue = getRefreshTokenFromCookie(req, client.clientId);
  if (refreshTokenValue) {
    const refreshToken = await db.refreshTokens.get(refreshTokenValue);
    if (
      refreshToken?.clientId === client.id &&
      refreshToken.userId !== userId
    ) {
      return true;
    }
  }
  return false;
};

/**
 * The browser is identified by its SSO cookie, the hint's `sid`, and its
 * refresh-token cookie; their SSO sessions end and every token family tied
 * to them is revoked. The user's other browsers and devices stay signed in
 * (DELETE /account/sessions signs out everywhere). With none of those
 * present, nothing is revoked: the cookies are cleared and the logout still
 * succeeds.
 */
const endThisBrowser = async (
  req: Request,
  res: Response,
  client: ClientRecord,
  hint: IdTokenPayload | null,
  method: "id_token_hint" | "confirm"
) => {
  const userSessionIds = new Set<string>();
  const authCodeIds = new Set<string>();
  // Who is signing out, with the SSO sessions of theirs that end: one
  // LOGOUT entry each.
  const signingOut = new Map<string, Set<string>>();
  const signOut = (userId: string, sid?: string) => {
    const sids = signingOut.get(userId) ?? new Set<string>();
    if (sid) sids.add(sid);
    signingOut.set(userId, sids);
  };

  const ssoToken = getUserSessionFromCookie(req, client.clientId);
  if (ssoToken) {
    const session = await db.userSessions.getUserSessionByToken(ssoToken);
    if (session) {
      userSessionIds.add(session.id);
      signOut(session.userId, session.id);
    }
  }

  if (hint?.sid) {
    const session = await db.userSessions.getUserSessionById(hint.sid);
    if (session && session.userId === hint.sub) {
      userSessionIds.add(session.id);
      signOut(session.userId, session.id);
    }
  }

  const refreshTokenValue = getRefreshTokenFromCookie(req, client.clientId);
  if (refreshTokenValue) {
    const refreshToken = await db.refreshTokens.get(refreshTokenValue);
    if (refreshToken?.clientId === client.id && refreshToken.authCodeId) {
      authCodeIds.add(refreshToken.authCodeId);
      signOut(refreshToken.userId);
    }
  }

  const users = await Promise.all(
    [...signingOut.keys()].map((id) => db.users.get(id))
  );

  // Failures propagate: a caller told it is logged out must be.
  await endBrowserSessions(
    {
      userSessionIds: [...userSessionIds],
      authCodeIds: [...authCodeIds],
    },
    async (tx, revoked) => {
      const ended = new Set(revoked.ssoSessionIds);
      for (const user of users) {
        await logAuditTx(tx, {
          auth: { userId: user.id, email: user.email },
          action: "LOGOUT",
          entityType: "User",
          entityId: user.id,
          entityName: user.email,
          metadata: {
            client_id: client.clientId,
            // The SSO sessions ended, and every refresh token revoked with
            // them: the cookie's family and its siblings in this browser.
            sids: [...signingOut.get(user.id)!].filter((sid) => ended.has(sid)),
            sessionIds: revoked.tokens
              .filter((t) => t.userId === user.id)
              .map((t) => t.id),
            method,
          },
        });
      }
    }
  );

  clearAllSessionCookies(res, client.clientId);
  clearAuthCookies(res, "end_session", client.clientId);
};

const sameToken = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * The client a confirmation is for, once the token sent matches the one
 * core set in this browser's cookie when it sent it to the confirm page.
 */
const getConfirmedClient = async (
  req: Request,
  clientId: string,
  confirmToken: string
): Promise<ClientRecord> => {
  const client = await findClient(clientId);
  if (!client) throw new OAuth2Error("invalid_request", "Invalid client_id");

  const cookie = getLogoutConfirmFromCookie(req, client.clientId);
  if (!cookie || !sameToken(cookie, confirmToken)) {
    throw new OAuth2Error(
      "invalid_session",
      "This sign-out link has expired or was not started in this browser."
    );
  }
  return client;
};

/** What the confirm page shows: the client, and where to sign in again. */
export const endSessionConfirmGetHandler = async (
  req: Request,
  res: Response
) => {
  const query = validateQuery(EndSessionConfirmGetSchema, req);
  const client = await getConfirmedClient(
    req,
    query.client_id,
    query.confirm_token
  );
  res.json({
    client_name: client.name,
    sign_in_url: clientSignInUrl(client),
  });
};

/** The user confirmed: logs this browser out of the client. */
export const endSessionConfirmPostHandler = async (
  req: Request,
  res: Response
) => {
  const body = validateBody(EndSessionConfirmSchema, req);
  const client = await getConfirmedClient(
    req,
    body.client_id,
    body.confirm_token
  );
  checkPostLogoutRedirectUri(client, body.post_logout_redirect_uri);

  await endThisBrowser(req, res, client, null, "confirm");

  res.json({
    redirect_url: postLogoutRedirect(body.post_logout_redirect_uri, body.state),
    sign_in_url: clientSignInUrl(client),
  });
};
