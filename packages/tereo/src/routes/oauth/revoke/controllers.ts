import { disconnectTokenSockets } from "../../../websocket/emitters/index.js";
import { recordSessionsRevoked } from "../../../utils/sessionEvents.js";
import { validateBody } from "../../../utils/validateReq.js";
import { verifyAccessToken } from "../../../utils/tokens.js";
import { authenticateClient } from "../../../utils/auth.js";
import { logTokenRevoked } from "../../../utils/audit.js";
import { endSession } from "../../../utils/sessions.js";
import { OAuth2Error } from "../../../utils/errors.js";
import { logAuditTx } from "../../../utils/outbox.js";
import { RevokeRequestSchema } from "./schemas.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import {
  clearAuthCookies,
  clearUserSessionCookie,
  getRefreshTokenFromCookie,
  hasRefreshTokenCookie,
} from "../../../utils/cookies.js";

export const revokeHandler = async (req: Request, res: Response) => {
  const body = validateBody(RevokeRequestSchema, req);
  const client = await authenticateClient(req, res, body.client_id);

  const tokenToRevoke =
    body.token || getRefreshTokenFromCookie(req, client.clientId);
  // RFC 7009 section 2.1: token is required; the refresh cookie stands in
  // for it.
  if (!tokenToRevoke) {
    throw new OAuth2Error(
      "invalid_request",
      "Missing required parameter: token"
    );
  }
  // Verified, so a forged JWT cannot name another token's jti.
  const decoded = verifyAccessToken(tokenToRevoke);

  if (decoded) {
    const revoked = await db.$transaction(async (tx) => {
      const revoked = await db.accessTokens.revokeByJti(
        decoded.jti,
        client.id,
        tx
      );
      if (!revoked) return null;
      const user = await db.users.get(revoked.userId, tx);
      await logAuditTx(tx, {
        auth: { userId: user.id, email: user.email },
        action: "LOGOUT",
        entityType: "User",
        entityId: user.id,
        entityName: user.email,
        metadata: {
          action: "token_revoked",
          method: "revoke",
          tokenType: "access_token",
          jti: revoked.jti,
          clientId: client.clientId,
        },
      });
      return revoked;
    });
    if (revoked) disconnectTokenSockets([revoked.jti]);
  }

  // Revoking a refresh token is a logout: its whole family, and the SSO
  // session (the browser) it was issued under with every family tied to it,
  // or the SSO cookie would mint new tokens without a password.
  const refreshToken = await db.refreshTokens.get(tokenToRevoke);
  if (refreshToken && refreshToken.clientId === client.id) {
    const { user } = refreshToken;
    const record = recordSessionsRevoked(
      { userId: user.id, email: user.email },
      user,
      { self: true, method: "revoke" }
    );
    const { ssoSessionIds } = await endSession(
      refreshToken.id,
      // endSession lists the token it was given even when it was already
      // revoked (a repeated revoke, a rotated token): no revocation of it.
      (tx, ids, ssoIds) =>
        record(
          tx,
          refreshToken.revokedAt
            ? ids.filter((id) => id !== refreshToken.id)
            : ids,
          ssoIds
        )
    );
    if (ssoSessionIds.length > 0) clearUserSessionCookie(res, client.clientId);
  }

  logTokenRevoked(
    decoded ? "access_token" : "refresh_token",
    decoded?.jti,
    req.ip || req.socket.remoteAddress
  );

  if (hasRefreshTokenCookie(req, client.clientId)) {
    clearAuthCookies(res, "explicit_revocation", client.clientId);
  }

  res.status(200).send();
};
