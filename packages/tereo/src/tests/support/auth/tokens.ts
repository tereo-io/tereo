import { BASE_URL } from "./constants.js";
import { createHash } from "crypto";
import * as jose from "jose";

// JWT/ID Token Claim Interfaces
export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  auth_time?: number;
  nonce?: string;
  acr?: string;
  amr?: string[];
  azp?: string;
  at_hash?: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
  picture?: string;
}

// Decode JWT without verification (for testing claim values)
export function decodeJwt(token: string): IdTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }
  const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(payload) as IdTokenClaims;
}

// Validate ID token has required claims
export function validateIdTokenClaims(
  claims: IdTokenClaims,
  expectedIssuer: string,
  expectedClientId: string,
  expectedSubject: string,
  expectedNonce?: string
): void {
  // Required claims per OIDC Core 1.0 Section 2
  if (!claims.iss) throw new Error("Missing required claim: iss");
  if (!claims.sub) throw new Error("Missing required claim: sub");
  if (!claims.aud) throw new Error("Missing required claim: aud");
  if (!claims.exp) throw new Error("Missing required claim: exp");
  if (!claims.iat) throw new Error("Missing required claim: iat");

  // Validate claim values
  if (claims.iss !== expectedIssuer) {
    throw new Error(
      `Invalid iss: expected ${expectedIssuer}, got ${claims.iss}`
    );
  }

  if (claims.sub !== expectedSubject) {
    throw new Error(
      `Invalid sub: expected ${expectedSubject}, got ${claims.sub}`
    );
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expectedClientId)) {
    throw new Error(
      `Invalid aud: expected to contain ${expectedClientId}, got ${claims.aud}`
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) {
    throw new Error(`Token expired: exp ${claims.exp} <= now ${now}`);
  }

  if (claims.iat > now + 60) {
    throw new Error(`Invalid iat: ${claims.iat} is in the future`);
  }

  if (expectedNonce && claims.nonce !== expectedNonce) {
    throw new Error(
      `Invalid nonce: expected ${expectedNonce}, got ${claims.nonce}`
    );
  }
}

// OIDC Discovery Document interface
export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  scopes_supported: string[];
  response_types_supported: string[];
  response_modes_supported?: string[];
  grant_types_supported: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
  claims_supported: string[];
  [key: string]: unknown;
}

// JWKS interface
export interface JWK {
  kty: string;
  use?: string;
  kid?: string;
  alg?: string;
  n?: string;
  e?: string;
  [key: string]: unknown;
}

export interface JWKS {
  keys: JWK[];
}

// Fetch the OIDC discovery document
export async function fetchDiscoveryDocument(): Promise<DiscoveryDocument> {
  const response = await fetch(`${BASE_URL}/.well-known/openid-configuration`);
  if (!response.ok) {
    throw new Error(`Failed to fetch discovery document: ${response.status}`);
  }
  return response.json() as Promise<DiscoveryDocument>;
}

// Fetch the JWKS
export async function fetchJwks(): Promise<JWKS> {
  const response = await fetch(`${BASE_URL}/.well-known/jwks.json`);
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.status}`);
  }
  return response.json() as Promise<JWKS>;
}

// Compute at_hash per OIDC Core Section 3.1.3.6
// at_hash = base64url(left_half(SHA-256(access_token)))
function computeAtHash(accessToken: string, alg: string = "RS256"): string {
  // Determine hash algorithm based on signing algorithm
  let hashAlg: string;
  if (alg.includes("256")) {
    hashAlg = "sha256";
  } else if (alg.includes("384")) {
    hashAlg = "sha384";
  } else if (alg.includes("512")) {
    hashAlg = "sha512";
  } else {
    hashAlg = "sha256"; // Default
  }

  const hash = createHash(hashAlg).update(accessToken).digest();
  // Take the left-most half of the hash
  const leftHalf = hash.subarray(0, hash.length / 2);
  // Base64url encode
  return leftHalf.toString("base64url");
}

// Verify at_hash claim matches computed value
export function verifyAtHash(
  accessToken: string,
  atHash: string,
  alg: string = "RS256"
): boolean {
  const computed = computeAtHash(accessToken, alg);
  return computed === atHash;
}

// Verify ID token signature using JWKS
export async function verifyIdTokenSignature(
  idToken: string
): Promise<{ valid: boolean; payload: IdTokenClaims }> {
  const jwks = await fetchJwks();

  // Create a JWKS from the fetched keys
  const keyStore = jose.createLocalJWKSet({ keys: jwks.keys });

  try {
    const { payload } = await jose.jwtVerify(idToken, keyStore);
    return { valid: true, payload: payload as unknown as IdTokenClaims };
  } catch (_error) {
    return { valid: false, payload: decodeJwt(idToken) };
  }
}

// Get JWT header to extract algorithm
export function getJwtHeader(token: string): {
  alg: string;
  typ?: string;
  kid?: string;
} {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }
  const header = Buffer.from(parts[0], "base64url").toString("utf-8");
  return JSON.parse(header);
}

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface IntrospectResponse {
  active: boolean;
  scope?: string;
  client_id?: string;
  username?: string;
  token_type?: string;
  exp?: number;
  iat?: number;
  sub?: string;
  user_id?: string;
  aud?: string | string[];
  iss?: string;
  jti?: string;
}

export interface UserInfoResponse {
  sub?: string;
  name?: string;
  family_name?: string;
  given_name?: string;
  preferred_username?: string;
  email?: string;
  email_verified?: boolean;
  picture?: string;
  updated_at?: number;
  error?: string;
  error_description?: string;
}
