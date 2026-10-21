import { ForbiddenError, NotFoundError, OAuth2Error } from "./errors.js";
import { disconnectTokenSockets } from "../websocket/emitters/index.js";
import { createFailureLimiter, getIpIdentifier } from "./rateLimit.js";
import { TokenResponse } from "../routes/oauth/token/controllers.js";
import { generateAccessToken, generateIdToken } from "./tokens.js";
import { TokenRequest } from "../routes/oauth/token/schemas.js";
import { stepUpRequired, usedMfa } from "./authorization.js";
import { maySelectOrganization } from "./supportAccess.js";
import { presignUserPhotoUrl } from "./userPhotos.js";
import type { Request, Response } from "express";
import { tokenAudience } from "./coreAccess.js";
import { verifyCodeChallenge } from "./pkce.js";
import { ClientRecord } from "./db/clients.js";
import type { Prisma } from "./db/prisma.js";
import db from "./db/index.js";
import env from "../env.js";
import {
  generateRefreshToken,
  verifyClientSecret,
  verifyAuthorizationCodeBinding,
} from "./crypto.js";
import {
  logAuthCodeReuse,
  logRefreshTokenReuse,
  logTokenIssued,
  logTokenRefreshed,
} from "./audit.js";

interface UserClaims {
  name?: string;
  givenName?: string;
  familyName?: string;
  email?: string;
  picture?: string;
  updatedAt?: Date;
}

interface IdTokenContext {
  nonce?: string;
  authTime?: Date;
  userClaims?: UserClaims;
  authMethods?: string[];
  acr?: string;
  sessionId?: string;
}

export interface BasicAuth {
  clientId: string;
  clientSecret: string;
}

/** RFC 6749 section 2.3.1: both halves are form-urlencoded before base64. */
const formUrlDecode = (value: string): string | null => {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return null;
  }
};

export const parseBasicAuth = (req: Request): BasicAuth | null => {
  const authHeader = req.headers.authorization;
  // The auth-scheme is case-insensitive (RFC 9110 section 11.1).
  const credentials = authHeader?.match(/^basic +(\S+) *$/i)?.[1];
  if (!credentials) return null;

  const decoded = Buffer.from(credentials, "base64").toString("utf-8");
  // The secret may itself contain a colon; only the first one separates.
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  const clientId = formUrlDecode(decoded.slice(0, colon));
  const clientSecret = formUrlDecode(decoded.slice(colon + 1));

  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
};

/**
 * The 401 `invalid_client` of RFC 6749 section 5.2, with the
 * `WWW-Authenticate` challenge it requires.
 */
export const clientAuthenticationFailed = (res: Response): OAuth2Error => {
  res.set("WWW-Authenticate", 'Basic realm="oauth"');
  return new OAuth2Error("invalid_client", "Client authentication failed", 401);
};

/**
 * The client a token-endpoint-style request comes from: a confidential
 * client by HTTP Basic (`client_secret_basic`), a public client by the
 * `client_id` it sends. A `client_id` beside Basic credentials must name the
 * same client. A confidential client of a deactivated service or integration
 * fails as a wrong secret does.
 */
export const authenticateClient = async (
  req: Request,
  res: Response,
  bodyClientId: string | undefined
): Promise<ClientRecord> => {
  const basicAuth = parseBasicAuth(req);
  assertSameClient(basicAuth, bodyClientId);
  const clientId = basicAuth?.clientId ?? bodyClientId;
  if (!clientId) throw clientAuthenticationFailed(res);

  const client = await db.clients.getByClientId(clientId).catch((err) => {
    if (err instanceof NotFoundError) throw clientAuthenticationFailed(res);
    throw err;
  });
  if (client.clientType === "public") return client;

  if (
    !basicAuth ||
    !client.clientSecret ||
    !(await verifyClientSecretLimited(req, client, basicAuth.clientSecret))
  ) {
    throw clientAuthenticationFailed(res);
  }
  if (
    client.serviceAccountUser?.isActive === false ||
    (await db.services.getByClientId(client.id))?.isActive === false
  ) {
    throw clientAuthenticationFailed(res);
  }
  return client;
};

// Wrong client secrets at /oauth/token, /oauth/revoke and /oauth/introspect,
// per client and IP: one address guessing cannot lock the client out for its
// other callers. Only wrong secrets are counted, so any number of concurrent
// correct ones from one address (pods behind one NAT) pass; once the count
// is full every attempt, the right secret included, is refused before it is
// hashed until the window expires. Without Redis it lets attempts through
// (failOpen): the secret is verified either way, and client authentication
// must not go down with Redis. Pass the client_id as the subject.
const clientSecretFailure = createFailureLimiter({
  keyPrefix: "rl:client:fail",
  points: 10,
  duration: 300,
  errorDescription:
    "Too many failed client authentication attempts. Please try again later.",
  getKey: (req, clientId) => `${clientId}:${getIpIdentifier(req)}`,
  logExtra: (req) => ({ clientId: parseBasicAuth(req)?.clientId }),
  failOpen: true,
});

/**
 * `verifyClientSecret` behind the per-client-and-IP failure limiter: with the
 * failure count full it throws the 429 before hashing anything; a wrong
 * secret adds one, a match clears the count.
 */
export const verifyClientSecretLimited = async (
  req: Request,
  client: ClientRecord,
  secret: string
): Promise<boolean> => {
  await clientSecretFailure.assertUnderLimit(req, client.clientId);
  const valid = await verifyClientSecret(client, secret);
  if (valid) await clientSecretFailure.reset(req, client.clientId);
  else await clientSecretFailure.recordFailure(req, client.clientId);
  return valid;
};

export const assertSameClient = (
  basicAuth: BasicAuth | null,
  bodyClientId: string | undefined
) => {
  if (basicAuth && bodyClientId && bodyClientId !== basicAuth.clientId) {
    throw new OAuth2Error(
      "invalid_request",
      "client_id does not match the authenticated client"
    );
  }
};

export const handleClientCredentials = async (
  client: ClientRecord,
  body: TokenRequest & { grant_type: "client_credentials" }
): Promise<TokenResponse> => {
  const requestedScopes = body.scope ? body.scope.split(" ") : [];
  const invalidScopes = requestedScopes.filter(
    (s) => !client.scopes.includes(s)
  );
  if (invalidScopes.length > 0) {
    return {
      status: "error",
      error: "invalid_scope",
      error_description: `Invalid scope(s): ${invalidScopes.join(", ")}`,
    };
  }

  if (!client.serviceAccountUser) {
    return {
      status: "error",
      error: "unauthorized_client",
      error_description:
        "Client does not have a service account user for client_credentials grant",
    };
  }
  // A deactivated service's account user is inactive: its tokens would be
  // refused on use, so none is minted.
  if (!client.serviceAccountUser.isActive) {
    return {
      status: "error",
      error: "unauthorized_client",
      error_description: "Client's service account is inactive",
    };
  }

  // A deactivated organization's tokens are revoked; none is minted for it.
  if (
    client.organizationId &&
    !(await isActiveOrganization(client.organizationId))
  ) {
    return {
      status: "error",
      error: "unauthorized_client",
      error_description: "Client's organization is inactive",
    };
  }

  const { token } = await handleCreateTokens(
    client,
    requestedScopes,
    "client_credentials",
    undefined,
    undefined,
    undefined,
    client.organizationId ?? undefined
  );
  return {
    status: "success",
    access_token: token,
    token_type: "Bearer",
    expires_in: env.JWT_ACCESS_TOKEN_TTL,
    scope: requestedScopes.join(" "),
  };
};

export const handleAuthorizationCode = async (
  client: ClientRecord,
  body: TokenRequest & { grant_type: "authorization_code" },
  ip?: string
): Promise<TokenResponse> => {
  const code = await getAuthorizationCode(client, body, ip);

  // max_age is enforced at authorize: a stale session is sent back to the
  // login page there, so a code always carries a login that satisfied it.
  // Re-checking here would fail max_age=0 on every interactive login.

  // Removing a member or deactivating an organization revokes its tokens but
  // not a code already issued for it.
  if (code.organizationId && !(await maySelectGrantOrganization(code))) {
    throw new Error("invalid_grant");
  }

  const idTokenContext: IdTokenContext = {
    ...(await loginIdTokenContext(code.user, code, code.scopes)),
    nonce: code.nonce ?? undefined,
  };

  const { token, refreshToken, idToken } = await db.$transaction(async (tx) => {
    await db.users.lockForTokenIssue(code.userId, tx);
    // Atomic, so two exchanges racing past the lock cannot both redeem it.
    if (!(await db.authorizationCode.markUsed(code.id, tx))) {
      throw new Error("invalid_grant");
    }
    return handleCreateTokens(
      client,
      code.scopes,
      "authorization_code",
      code.userId,
      code.id,
      idTokenContext,
      code.organizationId ?? undefined,
      undefined,
      undefined,
      tx
    );
  });
  return {
    status: "success",
    access_token: token,
    ...(idToken && { id_token: idToken }),
    token_type: "Bearer",
    expires_in: env.JWT_ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope: code.scopes.join(" "),
  };
};

/**
 * Whether the user may still select the grant's organization: a member of it
 * or a support-access holder, and it is active.
 */
const maySelectGrantOrganization = async (grant: {
  userId: string;
  organizationId: string | null;
}): Promise<boolean> => {
  if (!grant.organizationId) return false;
  return (await maySelectOrganization(grant.userId, grant.organizationId))
    .allowed;
};

/** False for an inactive, archived or missing organization. */
export const isActiveOrganization = async (id: string): Promise<boolean> => {
  const org = await db.organizations.get(id).catch((err) => {
    if (err instanceof NotFoundError) return null;
    throw err;
  });
  return !!org?.isActive;
};

/** The ID token's claims about the user and the login behind the grant. */
const loginIdTokenContext = async (
  user: {
    name: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string;
    photoObjectId: string | null;
    updatedAt: Date;
  },
  login: {
    authTime: Date | null;
    authMethods: string[] | null;
    userSessionId: string | null;
  },
  scopes: string[]
): Promise<IdTokenContext> => {
  const authMethods = login.authMethods || ["pwd"];
  const hasMfa = usedMfa(authMethods);

  // The presigned URL has a 1h TTL, which is shorter than typical id_token
  // lifetimes. Conformant OIDC clients refetch userinfo for fresh claims
  // rather than caching id_token contents, so a stale `picture` here is the
  // standards-encouraged failure mode.
  // OIDC Core 5.4: the profile and email claims follow their scopes, as
  // they do at userinfo.
  const profile = scopes.includes("profile");
  const picture =
    profile && user.photoObjectId
      ? await presignUserPhotoUrl(user.photoObjectId)
      : undefined;

  return {
    authTime: login.authTime ?? undefined,
    authMethods,
    acr: hasMfa ? "urn:auth-service:mfa" : "urn:auth-service:pwd",
    sessionId: login.userSessionId ?? undefined,
    userClaims: {
      ...(profile && {
        name: user.name ?? undefined,
        givenName: user.firstName ?? undefined,
        familyName: user.lastName ?? undefined,
        picture,
        updatedAt: user.updatedAt,
      }),
      ...(scopes.includes("email") && { email: user.email }),
    },
  };
};

const getAuthorizationCode = async (
  client: ClientRecord,
  body: TokenRequest & { grant_type: "authorization_code" },
  ip?: string
) => {
  const code = await db.authorizationCode.get(body.code);
  if (!code) throw new Error("invalid_grant");
  const bound = verifyAuthorizationCodeBinding(body.code, client.clientId);
  if (!bound) throw new Error("invalid_grant");
  if (code.clientId !== client.id) throw new Error("invalid_grant");
  if (!code.user.isActive) throw new Error("invalid_grant");
  if (code.usedAt) {
    await revokeFamily(code.userId, code.id);

    logAuthCodeReuse(client.clientId, code.userId, code.id, ip);

    throw new Error("invalid_grant");
  }
  if (code.expiresAt < new Date()) throw new Error("invalid_grant");
  if (code.redirectUri !== body.redirect_uri) throw new Error("invalid_grant");

  if (!code.codeChallenge) throw new Error("invalid_grant");
  if (!body.code_verifier) throw new Error("invalid_grant");

  const method = code.codeChallengeMethod || "S256";
  if (method !== "S256") throw new Error("invalid_grant");

  const valid = verifyCodeChallenge(
    body.code_verifier,
    code.codeChallenge,
    method
  );

  if (!valid) throw new Error("invalid_grant");

  return code;
};

export const handleRefreshToken = async (
  client: ClientRecord,
  body: TokenRequest & { grant_type: "refresh_token" },
  refreshTokenFromCookie?: string,
  ip?: string
): Promise<TokenResponse> => {
  const old = await getRefreshToken(client, body, refreshTokenFromCookie, ip);
  // A member removed or an organization deactivated while this refresh was
  // in flight: the session end's revocation may not have caught it.
  if (old.organizationId && !(await maySelectGrantOrganization(old))) {
    await revokeLostOrganizationGrant(old);
    throw new Error("invalid_grant");
  }
  // RFC 6749 section 6: a refresh may narrow the access token's scope, never
  // widen it; the rotated refresh token keeps the whole grant. Checked before
  // the token is revoked, so a refused scope does not burn it. A scope since
  // withdrawn from the client leaves the grant, silently: the client asking
  // for it is no error of its own.
  const grant = old.scopes.filter((s) => client.scopes.includes(s));
  const scopes = narrowScopes(old.scopes, body.scope).filter((s) =>
    grant.includes(s)
  );
  const login = old.authCodeId
    ? await db.authorizationCode.getLoginContextById(old.authCodeId)
    : null;
  // 2FA required of the user since a login without it: the client signs
  // them in again, through the second factor.
  if (await stepUpRequired(old.userId, login?.authMethods || ["pwd"])) {
    throw new Error("invalid_grant");
  }
  // Carry the authorization-code id forward as the token-family identifier so
  // every rotation stays linked. Without this, the family lineage is lost after
  // the first rotation and reuse detection (revokeByAuthCodeId) can only ever
  // reach first-generation tokens.
  // OIDC Core 12.2: a fresh ID token for the same login — its sid and
  // auth_time, and no nonce — so the client always holds a usable
  // id_token_hint for logout. The access token carries the login's
  // auth_time too, with or without openid.
  const idTokenContext = login
    ? await loginIdTokenContext(old.user, login, scopes)
    : undefined;
  const { token, refreshToken, idToken } = await db.$transaction(async (tx) => {
    await db.users.lockForTokenIssue(old.userId, tx);
    if (!(await db.refreshTokens.rotateIfActive(old.id, tx))) {
      throw new Error("invalid_grant");
    }
    return handleCreateTokens(
      client,
      scopes,
      "refresh_token",
      old.userId,
      old.authCodeId ?? undefined,
      idTokenContext,
      old.organizationId ?? undefined,
      old.expiresAt,
      grant,
      tx
    );
  });
  return {
    status: "success",
    access_token: token,
    ...(idToken && { id_token: idToken }),
    token_type: "Bearer",
    expires_in: env.JWT_ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  };
};

/** Revokes a token family on reuse, serialized like any other session end. */
const revokeFamily = async (userId: string, authCodeId: string) => {
  const jtis = await db.$transaction(async (tx) => {
    await db.users.lockForSessionEnd(tx, { userIds: [userId] });
    const revoked = await db.accessTokens.revokeByAuthCodeId(authCodeId, tx);
    await db.refreshTokens.revokeByAuthCodeId(authCodeId, tx);
    return revoked;
  });
  // Suspected theft: the family's sockets close now, not at their tokens' exp.
  disconnectTokenSockets(jtis);
};

/** Revokes a refresh token whose organization the user no longer has. */
const revokeLostOrganizationGrant = async (token: {
  id: string;
  userId: string;
  authCodeId: string | null;
}) => {
  if (token.authCodeId) return revokeFamily(token.userId, token.authCodeId);
  await db.$transaction(async (tx) => {
    await db.users.lockForSessionEnd(tx, { userIds: [token.userId] });
    await db.accessTokens.revokeByRefreshTokenIds([token.id], tx);
    await db.refreshTokens.revokeByIds([token.id], tx);
  });
};

/** The requested subset of the granted scopes; all of them when none named. */
const narrowScopes = (granted: string[], requested?: string): string[] => {
  if (!requested) return granted;
  const scopes = requested.split(" ").filter(Boolean);
  const extra = scopes.filter((s) => !granted.includes(s));
  if (extra.length > 0) {
    throw new OAuth2Error(
      "invalid_scope",
      `Scope(s) not granted to this refresh token: ${extra.join(", ")}`
    );
  }
  return scopes;
};

/**
 * How long after its rotation a replayed refresh token is not called reuse,
 * as long as its successor has not been used yet.
 */
export const REUSE_GRACE_MS = 5_000;

/**
 * A refresh token replayed within `REUSE_GRACE_MS` of its rotation, its
 * successor still unused: an `invalid_grant` that leaves the refresh cookie,
 * which the concurrent request has already replaced with the successor.
 */
export class RefreshRaceError extends Error {
  constructor() {
    super("invalid_grant");
    this.name = "RefreshRaceError";
  }
}

const getRefreshToken = async (
  client: ClientRecord,
  body: TokenRequest & { grant_type: "refresh_token" },
  refreshTokenFromCookie?: string,
  ip?: string
) => {
  const refreshTokenValue = body.refresh_token ?? refreshTokenFromCookie;
  if (!refreshTokenValue) throw new Error("invalid_grant");
  const token = await db.refreshTokens.get(refreshTokenValue);
  if (!token) throw new Error("invalid_grant");
  if (token.clientId !== client.id) throw new Error("invalid_grant");
  if (token.revokedAt) {
    // Ended by logout or an admin, not spent on a refresh: nothing was
    // reused, and the rest of the family was dealt with by whoever ended it.
    if (!token.rotatedAt) throw new Error("invalid_grant");
    // Just rotated: most likely two tabs or a retry refreshing with the same
    // token at once. Refused, but the family (and the successor the other
    // request received) is left alone. Not once the successor has been
    // spent too: a racing request would not be that far behind, but a thief
    // who rotated the stolen token first and kept going would.
    if (
      Date.now() - token.rotatedAt.getTime() < REUSE_GRACE_MS &&
      !(
        token.authCodeId &&
        (await db.refreshTokens.familyRotatedSince(
          token.authCodeId,
          token.rotatedAt
        ))
      )
    ) {
      throw new RefreshRaceError();
    }
    // Presenting an already-rotated refresh token is the classic breach
    // signal from the OAuth 2.0 Security BCP: the legitimate client and an
    // attacker now hold divergent lineages of the same grant. Revoke the
    // entire token family — refresh tokens and their derived access tokens —
    // so the attacker's rotated chain is killed too, and audit it.
    if (token.authCodeId) await revokeFamily(token.userId, token.authCodeId);
    logRefreshTokenReuse(client.clientId, token.userId, ip);
    throw new Error("invalid_grant");
  }
  if (token.expiresAt < new Date()) throw new Error("invalid_grant");
  if (!token.user.isActive) throw new Error("invalid_grant");
  return token;
};

const handleCreateTokens = async (
  client: ClientRecord,
  scopes: string[],
  grantType: string,
  userId?: string,
  authCodeId?: string,
  idTokenContext?: IdTokenContext,
  organizationId?: string,
  familyExpiresAt?: Date,
  refreshScopes: string[] = scopes,
  tx?: Prisma.TransactionClient
) => {
  const { refreshToken, refreshTokenId } = await createRefreshToken(
    client,
    refreshScopes,
    userId,
    authCodeId,
    organizationId,
    familyExpiresAt,
    tx
  );

  const { token, jti, expiresAt } = generateAccessToken({
    subject: userId ?? client.clientId,
    clientId: client.clientId,
    scopes,
    audience: tokenAudience(client.audience, scopes),
    sessionId: refreshTokenId,
    organizationId,
    authTime: idTokenContext?.authTime,
  });

  // client_credentials tokens have no end user; the stored token names the
  // client's service-account user, the identity the client acts as.
  const tokenUserId = userId ?? client.serviceAccountUser?.id;
  if (!tokenUserId) {
    throw new Error(`Client ${client.clientId} has no service-account user`);
  }

  await db.accessTokens.create(
    {
      jti,
      clientId: client.id,
      userId: tokenUserId,
      authCodeId: authCodeId || null,
      refreshTokenId: refreshTokenId || null,
      scopes,
      expiresAt,
      organizationId: organizationId || null,
    },
    tx
  );

  let idToken: string | undefined;
  if (scopes.includes("openid") && userId && idTokenContext) {
    const idTokenResult = generateIdToken({
      subject: userId,
      clientId: client.clientId,
      accessToken: token,
      authTime: idTokenContext.authTime,
      nonce: idTokenContext.nonce,
      acr: idTokenContext.acr,
      amr: idTokenContext.authMethods,
      claims: idTokenContext.userClaims,
      organizationId,
      sessionId: idTokenContext.sessionId,
    });
    idToken = idTokenResult.token;
  }

  logTokenIssued(client.clientId, userId, grantType, scopes, jti);
  if (refreshTokenId) {
    logTokenRefreshed(client.clientId, userId!, scopes, jti);
  }
  return { token, refreshToken, idToken };
};

const createRefreshToken = async (
  client: ClientRecord,
  scopes: string[],
  userId?: string,
  authCodeId?: string,
  organizationId?: string,
  familyExpiresAt?: Date,
  tx?: Prisma.TransactionClient
): Promise<{ refreshToken?: string; refreshTokenId?: string }> => {
  // Only for a user, and only to a client allowed to use one.
  if (!userId || !client.grantTypes.includes("refresh_token")) return {};
  const refreshToken = generateRefreshToken();
  // A rotated token inherits its family's expiry: JWT_REFRESH_TOKEN_TTL is an
  // absolute lifetime from the authorization-code exchange, not a sliding one.
  const refreshExpiresAt =
    familyExpiresAt ?? new Date(Date.now() + env.JWT_REFRESH_TOKEN_TTL * 1000);

  const refreshTokenId = await db.refreshTokens.create(
    {
      token: refreshToken,
      clientId: client.id,
      userId,
      authCodeId: authCodeId || null,
      scopes,
      expiresAt: refreshExpiresAt,
      organizationId: organizationId || null,
    },
    tx
  );

  return { refreshToken, refreshTokenId };
};

export const validateUser = (req: Request) => {
  if (!req.auth) throw new ForbiddenError("Authentication required");
  return req.auth;
};
