import { OAuth2Error, NotFoundError } from "../../../utils/errors.js";
import { acquireLock, releaseLock } from "../../../utils/redis.js";
import { validateBody } from "../../../utils/validateReq.js";
import { ClientRecord } from "../../../utils/db/clients.js";
import { hashFlowToken } from "../../../utils/crypto.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import env from "../../../env.js";
import {
  clearAuthCookies,
  getRefreshTokenFromCookie,
  setAuthCookies,
} from "../../../utils/cookies.js";
import {
  logAuthCodeValidationFailure,
  logAuthFailure,
  logClientAuthFailure,
} from "../../../utils/audit.js";
import {
  BasicAuth,
  assertSameClient,
  clientAuthenticationFailed,
  handleAuthorizationCode,
  handleClientCredentials,
  handleRefreshToken,
  RefreshRaceError,
  parseBasicAuth,
  verifyClientSecretLimited,
} from "../../../utils/auth.js";
import {
  TokenRequest,
  TokenRequestSchema,
  TokenRequestSchemaLoose,
} from "./schemas.js";

export type TokenResponse = OAuthTokenData | OAuthTokenError;

interface OAuthTokenData {
  status: "success";
  access_token: string;
  id_token?: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

interface OAuthTokenError {
  status: "error";
  error: string;
  error_description: string;
  /**
   * Lost a race to a concurrent use of the same grant (its lock, or a
   * refresh token rotated moments ago): the grant or its successor may be
   * fine, so the refresh cookie is left alone.
   */
  contended?: true;
}

// Supported grant types - used to check for unsupported_grant_type error
const SUPPORTED_GRANT_TYPES = [
  "client_credentials",
  "authorization_code",
  "refresh_token",
];

export const tokenHandler = async (req: Request, res: Response) => {
  const looseBody = validateBody(TokenRequestSchemaLoose, req);
  const basicAuth = parseBasicAuth(req);
  assertSameClient(basicAuth, looseBody.client_id);

  // RFC 6749 Section 5.2: unsupported_grant_type
  if (!SUPPORTED_GRANT_TYPES.includes(looseBody.grant_type)) {
    throw new OAuth2Error(
      "unsupported_grant_type",
      `Grant type '${looseBody.grant_type}' is not supported`
    );
  }

  // RFC 6749 Section 5.2: Missing required parameters = invalid_request
  // Check client_id first (required for all grant types except client_credentials with Basic Auth)
  const hasClientId = basicAuth?.clientId || looseBody.client_id;
  if (!hasClientId && looseBody.grant_type !== "client_credentials") {
    throw new OAuth2Error(
      "invalid_request",
      "Missing required parameter: client_id"
    );
  }

  // RFC 7636 Section 4.6: Missing code_verifier for authorization_code grant = invalid_grant
  if (
    looseBody.grant_type === "authorization_code" &&
    !looseBody.code_verifier
  ) {
    throw new OAuth2Error(
      "invalid_grant",
      "Missing required parameter: code_verifier"
    );
  }

  // RFC 6749 Section 5.2: Missing refresh_token for refresh_token grant = invalid_request
  // (Check both body and cookie - if neither has a token, it's a missing parameter)
  if (looseBody.grant_type === "refresh_token") {
    const hasRefreshTokenInBody = !!looseBody.refresh_token;
    // For cookie check, we need the clientId - get it from basicAuth or body
    const clientIdForCookie = basicAuth?.clientId ?? looseBody.client_id;
    const hasRefreshTokenInCookie = clientIdForCookie
      ? !!getRefreshTokenFromCookie(req, clientIdForCookie)
      : false;
    if (!hasRefreshTokenInBody && !hasRefreshTokenInCookie) {
      throw new OAuth2Error(
        "invalid_request",
        "Missing required parameter: refresh_token"
      );
    }
  }

  const body = validateBody(TokenRequestSchema, req);

  const client = await getClient(req, res, basicAuth, body);

  const ip = req.ip || req.socket.remoteAddress;
  const refreshTokenFromCookie = getRefreshTokenFromRequest(req, body, client);
  const response = await getResponse(client, body, ip, refreshTokenFromCookie);
  if (response.status === "error") {
    // A dead refresh cookie would otherwise be retried on every page load.
    if (
      refreshTokenFromCookie &&
      response.error === "invalid_grant" &&
      !response.contended
    ) {
      clearAuthCookies(res, "invalid_refresh_token", client.clientId);
    }
    throw new OAuth2Error(response.error, response.error_description);
  }

  const responseMode = getRefreshTokenResponseMode(body);
  if (responseMode === "cookie" && response.refresh_token) {
    const stored = await db.refreshTokens.get(response.refresh_token);
    setAuthCookies(
      res,
      response.refresh_token,
      client.clientId,
      stored?.expiresAt ??
        new Date(Date.now() + env.JWT_REFRESH_TOKEN_TTL * 1000)
    );
    res.json({
      access_token: response.access_token,
      ...(response.id_token && { id_token: response.id_token }),
      token_type: response.token_type,
      expires_in: response.expires_in,
      scope: response.scope,
    });
    return;
  }

  res.json({
    access_token: response.access_token,
    ...(response.id_token && { id_token: response.id_token }),
    token_type: response.token_type,
    expires_in: response.expires_in,
    refresh_token: response.refresh_token,
    scope: response.scope,
  });
};

const getRefreshTokenResponseMode = (body: TokenRequest) => {
  if (body.grant_type === "client_credentials") return;
  return body.refresh_token_response_mode;
};

const getRefreshTokenFromRequest = (
  req: Request,
  body: TokenRequest,
  client: ClientRecord
): string | undefined => {
  if (body.grant_type !== "refresh_token") return undefined;
  if (body.refresh_token) return undefined;
  return getRefreshTokenFromCookie(req, client.clientId);
};

const getClient = async (
  req: Request,
  res: Response,
  basicAuth: BasicAuth | null,
  body: TokenRequest & { grant_type: string; client_id?: string }
) => {
  const ip = req.ip || req.socket.remoteAddress;

  // Determine client_id from Basic Auth or request body
  const clientId = basicAuth?.clientId ?? body.client_id;
  if (!clientId) {
    // RFC 6749 Section 5.2: missing required parameter = invalid_request
    throw new OAuth2Error(
      "invalid_request",
      "Missing required parameter: client_id"
    );
  }

  // RFC 6749 section 5.2: an unknown client is invalid_client — 401 with a
  // challenge when it tried the Authorization header, else 400.
  let client: ClientRecord;
  try {
    client = await db.clients.getByClientId(clientId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      logClientAuthFailure(clientId, "Unknown client", body.grant_type, ip);
      if (basicAuth) throw clientAuthenticationFailed(res);
      throw new OAuth2Error("invalid_client", "Client authentication failed");
    }
    throw error;
  }

  if (!client.grantTypes.includes(body.grant_type)) {
    logClientAuthFailure(
      clientId,
      "Client not authorized for this grant type",
      body.grant_type,
      ip
    );
    throw new OAuth2Error(
      "unauthorized_client",
      "Client not authorized for this grant type"
    );
  }

  if (client.clientType === "public") {
    if (body.grant_type === "client_credentials") {
      logClientAuthFailure(
        clientId,
        "Public clients cannot use client_credentials grant",
        body.grant_type,
        ip
      );
      throw new OAuth2Error(
        "unauthorized_client",
        "Public clients cannot use client_credentials grant"
      );
    }
    return client;
  }

  if (!basicAuth) {
    logClientAuthFailure(
      clientId,
      "Confidential client requires authentication",
      body.grant_type,
      ip
    );
    throw clientAuthenticationFailed(res);
  }

  if (!client.clientSecret) {
    logClientAuthFailure(
      clientId,
      "Client has no secret configured",
      body.grant_type,
      ip
    );
    throw clientAuthenticationFailed(res);
  }

  const validSecret = await verifyClientSecretLimited(
    req,
    client,
    basicAuth.clientSecret
  );
  if (!validSecret) {
    logClientAuthFailure(
      clientId,
      "Invalid client credentials",
      body.grant_type,
      ip
    );
    throw clientAuthenticationFailed(res);
  }
  return client;
};

const getResponse = async (
  client: ClientRecord,
  body: TokenRequest & { grant_type: string },
  ip?: string,
  refreshTokenFromCookie?: string
): Promise<TokenResponse> => {
  // client_credentials is a stateless server-to-server grant — no single-use
  // semantic to protect, so concurrent mints for the same client are safe.
  // Skip the distributed lock; otherwise N services booting in parallel and
  // authenticating with the same client_id all serialize through one lock and
  // the losers get rejected with a misleading "is being processed".
  if (body.grant_type === "client_credentials") {
    return await handleClientCredentials(client, body);
  }

  const key = getLockKey(client, body, refreshTokenFromCookie);
  const lockToken = await acquireLock(key);
  if (!lockToken) {
    logAuthCodeValidationFailure(
      client.clientId,
      `${body.grant_type} is being processed`,
      key,
      ip
    );
    return {
      status: "error",
      error: "invalid_grant",
      error_description: `${body.grant_type} is being processed`,
      contended: true,
    };
  }
  try {
    switch (body.grant_type) {
      case "authorization_code":
        return await handleAuthorizationCode(client, body, ip);
      case "refresh_token":
        return await handleRefreshToken(
          client,
          body,
          refreshTokenFromCookie,
          ip
        );
    }
  } catch (error) {
    if (error instanceof RefreshRaceError) {
      logAuthFailure(
        client.clientId,
        "invalid_grant",
        "Refresh token already rotated by a concurrent request",
        ip
      );
      return {
        status: "error",
        error: "invalid_grant",
        error_description:
          "The provided authorization grant is invalid, expired, or revoked",
        contended: true,
      };
    }
    if (error instanceof Error && error.message === "invalid_grant") {
      logAuthFailure(
        client.clientId,
        "invalid_grant",
        "Token validation failed",
        ip
      );
      return {
        status: "error",
        error: "invalid_grant",
        error_description:
          "The provided authorization grant is invalid, expired, or revoked",
      };
    }
    throw error;
  } finally {
    await releaseLock(key, lockToken);
  }
};

// The credential's hash, never the credential: the key lands in Redis, its
// traces and the auth log.
export const getLockKey = (
  client: ClientRecord,
  body: TokenRequest & { grant_type: string },
  refreshTokenFromCookie?: string
) => {
  const credential =
    body.grant_type === "authorization_code"
      ? body.code
      : body.grant_type === "refresh_token"
        ? (body.refresh_token ?? refreshTokenFromCookie)
        : undefined;
  return credential
    ? `${body.grant_type}:${hashFlowToken(credential)}`
    : client.clientId;
};
