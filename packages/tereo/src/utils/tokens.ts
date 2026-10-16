import { currentSigningKey, verificationKeyFor } from "./keys.js";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";
import jwt from "jsonwebtoken";
import env from "../env.js";

export interface AccessTokenPayload {
  iss: string;
  sub: string;
  aud?: string | string[];
  exp: number;
  iat: number;
  jti: string;
  scope: string;
  client_id: string;
  sid?: string;
  org_id?: string;
  // RFC 9068: when the user signed in, for routes that need a recent login.
  auth_time?: number;
}

export interface TokenGenerationOptions {
  subject: string;
  clientId: string;
  scopes: string[];
  audience?: string[];
  expiresIn?: number;
  sessionId?: string;
  organizationId?: string;
  authTime?: Date;
}

export interface IdTokenPayload {
  iss: string; // Issuer
  sub: string; // Subject (user ID)
  aud: string; // Audience (client_id)
  exp: number; // Expiration
  iat: number; // Issued at
  auth_time?: number; // When user authenticated
  nonce?: string; // Replay protection
  at_hash?: string; // Access token hash
  acr?: string; // Authentication Context Class Reference
  amr?: string[]; // Authentication Methods References
  name?: string; // User's full name
  given_name?: string; // First name
  family_name?: string; // Last name
  email?: string; // Email address
  email_verified?: boolean; // Email verification status
  picture?: string; // Profile picture URL
  updated_at?: number; // Profile last updated (Unix timestamp)
  org_id?: string;
  sid?: string; // The SSO session (browser) the login belongs to
}

export interface IdTokenGenerationOptions {
  subject: string;
  clientId: string;
  accessToken?: string; // For calculating at_hash
  authTime?: Date; // When user authenticated
  nonce?: string; // From authorization request
  expiresIn?: number;
  acr?: string; // Authentication Context Class Reference
  amr?: string[]; // Authentication Methods References
  organizationId?: string;
  sessionId?: string; // SSO session id, issued as `sid`
  claims?: {
    name?: string;
    givenName?: string;
    familyName?: string;
    email?: string;
    picture?: string;
    updatedAt?: Date;
  };
}

export const generateAccessToken = (
  options: TokenGenerationOptions
): { token: string; jti: string; expiresAt: Date } => {
  const jti = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresIn ?? env.JWT_ACCESS_TOKEN_TTL;
  const exp = now + expiresIn;

  const payload: AccessTokenPayload = {
    iss: env.ISSUER,
    sub: options.subject,
    exp,
    iat: now,
    jti,
    scope: options.scopes.join(" "),
    client_id: options.clientId,
    sid: options.sessionId,
  };

  if (options.audience && options.audience.length > 0) {
    payload.aud =
      options.audience.length === 1 ? options.audience[0] : options.audience;
  }

  if (options.organizationId) {
    payload.org_id = options.organizationId;
  }

  if (options.authTime) {
    payload.auth_time = Math.floor(options.authTime.getTime() / 1000);
  }

  const { kid, privateKey } = currentSigningKey();
  const token = jwt.sign(payload, privateKey, {
    algorithm: "RS256",
    keyid: kid,
    header: { alg: "RS256", typ: ACCESS_TOKEN_TYP },
  });

  return {
    token,
    jti,
    expiresAt: new Date(exp * 1000),
  };
};

export interface TokenVerificationOptions {
  audience?: string | [string, ...string[]];
}

// The auth-scheme is case-insensitive (RFC 9110 section 11.1).
const BEARER_RE = /^bearer +(\S+) *$/i;

/** The token of an `Authorization: Bearer <token>` header, or null. */
export const bearerToken = (header: string | undefined): string | null =>
  header?.match(BEARER_RE)?.[1] ?? null;

export const verifyAccessToken = (
  token: string,
  options: TokenVerificationOptions = {}
): AccessTokenPayload | null => {
  try {
    const verifyOptions: jwt.VerifyOptions = {
      algorithms: ["RS256"],
      issuer: env.ISSUER,
    };

    if (options.audience) verifyOptions.audience = options.audience;

    const { header, payload } = jwt.verify(token, verificationKeyFor(token), {
      ...verifyOptions,
      complete: true,
    });
    if (!isAccessTokenPayload(payload)) return null;
    return isAccessTokenTyp(header.typ, payload.iat) ? payload : null;
  } catch {
    return null;
  }
};

/** RFC 9068 section 2.1: the `typ` header of a JWT access token. */
const ACCESS_TOKEN_TYP = "at+jwt";

const STARTED_AT = Math.floor(Date.now() / 1000);
// Covers the old replicas of a rolling deploy, which still issue untyped
// tokens after this one starts.
const UNTYPED_GRACE_SECONDS = 5 * 60;

/**
 * `at+jwt` (RFC 9068 section 4 also allows the `application/` form). Tokens
 * from before access tokens carried it have `JWT`; one is accepted only if
 * issued before this process started (plus a rollout's grace), so the
 * overlap lasts one access-token lifetime. The payload shape check still
 * refuses an ID token, which also has `JWT`.
 * TODO(2026-11-15): drop the untyped case once every deployment has run
 * a release with typed tokens for longer than JWT_ACCESS_TOKEN_TTL.
 */
const isAccessTokenTyp = (typ: unknown, iat: number): boolean => {
  if (typeof typ === "string") {
    const t = typ.toLowerCase();
    if (t === ACCESS_TOKEN_TYP || t === `application/${ACCESS_TOKEN_TYP}`) {
      return true;
    }
    if (t !== "jwt") return false;
  }
  return iat < STARTED_AT + UNTYPED_GRACE_SECONDS;
};

// ID tokens share the signing key and issuer but carry no jti, client_id or
// scope. Admitted as access tokens, an undefined jti reaches Prisma as "no
// filter": /oauth/revoke would revoke every access token of the client.
const isAccessTokenPayload = (
  payload: string | jwt.JwtPayload
): payload is AccessTokenPayload =>
  typeof payload === "object" &&
  typeof payload.jti === "string" &&
  payload.jti.length > 0 &&
  typeof payload.client_id === "string" &&
  payload.client_id.length > 0 &&
  typeof payload.sub === "string" &&
  typeof payload.scope === "string";

export const generateIdToken = (
  options: IdTokenGenerationOptions
): { token: string; expiresAt: Date } => {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresIn ?? env.JWT_ACCESS_TOKEN_TTL;
  const exp = now + expiresIn;

  const payload: IdTokenPayload = {
    iss: env.ISSUER,
    sub: options.subject,
    aud: options.clientId,
    exp,
    iat: now,
  };

  if (options.nonce) payload.nonce = options.nonce;
  if (options.authTime) {
    payload.auth_time = Math.floor(options.authTime.getTime() / 1000);
  }
  if (options.accessToken) {
    payload.at_hash = calculateAtHash(options.accessToken);
  }
  if (options.acr) payload.acr = options.acr;
  if (options.amr && options.amr.length > 0) payload.amr = options.amr;
  if (options.organizationId) {
    payload.org_id = options.organizationId;
  }
  if (options.sessionId) payload.sid = options.sessionId;

  if (options.claims) {
    if (options.claims.name) payload.name = options.claims.name;
    if (options.claims.givenName) payload.given_name = options.claims.givenName;
    if (options.claims.familyName)
      payload.family_name = options.claims.familyName;
    if (options.claims.email) {
      payload.email = options.claims.email;
      payload.email_verified = true;
    }
    if (options.claims.picture) payload.picture = options.claims.picture;
    if (options.claims.updatedAt) {
      payload.updated_at = Math.floor(
        options.claims.updatedAt.getTime() / 1000
      );
    }
  }

  const { kid, privateKey } = currentSigningKey();
  const token = jwt.sign(payload, privateKey, {
    algorithm: "RS256",
    keyid: kid,
  });
  return { token, expiresAt: new Date(exp * 1000) };
};

const calculateAtHash = (accessToken: string): string => {
  const hash = createHash("sha256").update(accessToken, "ascii").digest();
  const leftHalf = hash.subarray(0, hash.length / 2);
  return leftHalf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

/** How long past its `exp` an id token is still accepted as a logout hint. */
export const ID_TOKEN_HINT_GRACE_SECONDS = 60 * 60;

/**
 * An `id_token_hint` (OIDC RP-Initiated Logout): signed by core and issued by
 * this issuer, but possibly expired — the spec lets a logout name a session
 * whose id token has lapsed — though by no more than
 * ID_TOKEN_HINT_GRACE_SECONDS. Access tokens share the signing key, so a
 * token carrying `scope` is refused.
 */
export const verifyIdTokenHint = (token: string): IdTokenPayload | null => {
  try {
    const payload = jwt.verify(token, verificationKeyFor(token), {
      algorithms: ["RS256"],
      issuer: env.ISSUER,
      ignoreExpiration: true,
    });
    if (typeof payload !== "object" || "scope" in payload) return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number") return null;
    if (now - payload.exp > ID_TOKEN_HINT_GRACE_SECONDS) return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    if (typeof payload.aud !== "string" || !payload.aud) return null;
    return payload as IdTokenPayload;
  } catch {
    return null;
  }
};
