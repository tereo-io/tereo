import { hashPassword, generateClientSecret } from "../../../utils/crypto.js";
import { TEST_SERVICE, TEST_SERVICE_ID } from "../../utils/testService.js";
import { createHash, createHmac, randomBytes } from "crypto";
import { prisma } from "../../../utils/db/prisma.js";
import { CORE_URL } from "../../utils/coreUrl.js";
import * as jose from "jose";
import {
  CORE_SCOPES,
  CORE_SERVICE_ID,
  LOGIN_CLIENT,
} from "../../../definitions/index.js";

// Vite/Vitest inject BASE_URL="/" (the vite `base` default) into worker env,
// and the registry resolver's `??=` won't overwrite it — accept only an
// absolute origin so the injected "/" falls through to the default.
const envBaseUrl = process.env.BASE_URL;
export const BASE_URL = envBaseUrl?.startsWith("http") ? envBaseUrl : CORE_URL;

// Syntactically valid UUID (v7-shaped) used by tests as a sentinel for
// "this id is well-formed but does not exist in the DB". Use this where
// tests need to exercise NOT_FOUND paths after the route's strict UUID
// param/body validation introduced by the UUID v7 transition.
export const NON_EXISTENT_UUID = "00000000-0000-7000-8000-000000000000";

/**
 * Every core API scope. Test clients are granted them and test logins ask
 * for them, so a third-party token reaches all of core's API — capped, as
 * any delegated token is, at the scopes' ceilings.
 */
const ALL_CORE_SCOPES = CORE_SCOPES.map((s) => s.name);

// HTTP Status Code Constants for consistent test assertions
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  FOUND: 302,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_SERVER_ERROR: 500,
} as const;

// OAuth Error Codes per RFC 6749 and OIDC Core
export const OAUTH_ERRORS = {
  INVALID_REQUEST: "invalid_request",
  INVALID_CLIENT: "invalid_client",
  INVALID_GRANT: "invalid_grant",
  INVALID_SCOPE: "invalid_scope",
  INVALID_TOKEN: "invalid_token",
  UNAUTHORIZED_CLIENT: "unauthorized_client",
  UNSUPPORTED_GRANT_TYPE: "unsupported_grant_type",
  UNSUPPORTED_RESPONSE_TYPE: "unsupported_response_type",
  ACCESS_DENIED: "access_denied",
  SERVER_ERROR: "server_error",
  LOGIN_REQUIRED: "login_required",
  CONSENT_REQUIRED: "consent_required",
  INTERACTION_REQUIRED: "interaction_required",
  INVALID_SESSION: "invalid_session",
  INVALID_SETUP_TOKEN: "invalid_setup_token",
  INVALID_SETUP_GRANT: "invalid_setup_grant",
  INVALID_TOTP: "invalid_totp",
  MFA_REQUIRED: "mfa_required",
} as const;

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

// PKCE helpers
export function generateCodeVerifier(): string {
  return randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// RFC 6238 code for the current 30s step, computed independently of
// utils/totp.ts so the tests check the server against the spec. A code is
// accepted once, so a second use for the same user within a step takes
// `stepOffset` 1: the next step's code, still inside the server's window.
export function generateTotpCode(secret: string, stepOffset = 0): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of secret.toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigInt64BE(
    BigInt(Math.floor(Date.now() / 1000 / 30) + stepOffset)
  );
  const hash = createHmac("sha1", Buffer.from(bytes))
    .update(timeBuffer)
    .digest();

  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);
  return (binary % 1_000_000).toString().padStart(6, "0");
}

export function generateUniqueId(): string {
  return randomBytes(8).toString("hex");
}

// Create test client
export async function createTestClient(
  options: {
    clientType?: "public" | "confidential";
    scopes?: string[];
    grantTypes?: string[];
    redirectUris?: string[];
    postLogoutRedirectUris?: string[];
    audience?: string[];
    ownerId?: string;
  } = {}
) {
  const uniqueId = generateUniqueId();
  const clientId = `test-client-${uniqueId}`;

  // Get or create default owner if not provided
  let ownerId = options.ownerId;
  if (!ownerId) {
    // Use upsert to avoid race conditions when running tests in parallel
    const passwordHash = await hashPassword("TestPassword123!");
    const owner = await prisma.user.upsert({
      where: { email: "test-client-owner@test.local" },
      update: {}, // Don't update if exists
      create: {
        email: "test-client-owner@test.local",
        passwordHash,
        name: "Test Client Owner",
        isActive: true,
      },
    });
    ownerId = owner.id;
  }

  // Generate hashed secret for confidential clients
  let clientSecret: string | null = null;
  let plainSecret: string | null = null;
  if (options.clientType === "confidential") {
    const secretData = generateClientSecret();
    clientSecret = secretData.hashedSecret;
    plainSecret = secretData.plainSecret;
  }

  const grantTypes = options.grantTypes || [
    "authorization_code",
    "refresh_token",
  ];

  // Create service account user if client_credentials grant is requested
  let serviceAccountUserData: { connect: { id: string } } | undefined;
  if (grantTypes.includes("client_credentials")) {
    const serviceAccountPasswordHash = await hashPassword(
      "ServiceAccount123!@#"
    );
    const serviceAccountUser = await prisma.user.create({
      data: {
        email: `service-account-${uniqueId}@test.local`,
        passwordHash: serviceAccountPasswordHash,
        name: `Service Account ${uniqueId}`,
        isActive: true,
        userType: "service_account",
      },
    });
    serviceAccountUserData = { connect: { id: serviceAccountUser.id } };
  }

  const client = await prisma.oAuthClient.create({
    data: {
      clientId,
      clientSecret,
      clientType: options.clientType || "public",
      name: `Test Client ${uniqueId}`,
      redirectUris: options.redirectUris || ["http://localhost:3000/callback"],
      postLogoutRedirectUris: options.postLogoutRedirectUris || [
        "http://localhost:3000/logout",
      ],
      scopes: options.scopes || [
        "openid",
        "profile",
        "email",
        "offline_access",
        ...ALL_CORE_SCOPES,
      ],
      grantTypes,
      audience: options.audience || [],
      ownerId,
      serviceAccountUser: serviceAccountUserData,
    },
  });

  return {
    ...client,
    plainSecret,
  };
}

// Create test user
export async function createTestUser(
  options: {
    email?: string;
    password?: string;
    name?: string;
    isActive?: boolean;
  } = {}
) {
  const uniqueId = generateUniqueId();
  const email = options.email || `test-user-${uniqueId}@test.local`;
  const password = options.password || "TestPassword123!";

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: options.name || `Test User ${uniqueId}`,
      isActive: options.isActive ?? true,
    },
  });

  return {
    ...user,
    passwordHash,
    plainPassword: password,
  };
}

// Create test role
export async function createTestRole(
  options: {
    name?: string;
    displayName?: string;
    description?: string;
    isSystem?: boolean;
  } = {}
) {
  const uniqueId = generateUniqueId();

  const role = await prisma.role.create({
    data: {
      // A system role is the test service's, named under its namespace.
      name:
        options.name ||
        (options.isSystem
          ? `${TEST_SERVICE.namespace}_role-${uniqueId}`
          : `test-role-${uniqueId}`),
      displayName: options.displayName || `Test Role ${uniqueId}`,
      description: options.description || "Test role for testing",
      serviceId: options.isSystem ? TEST_SERVICE_ID : null,
      isActive: true,
      requires2fa: false,
    },
  });

  return role;
}

// Create test permission
export async function createTestPermission(
  options: {
    name?: string;
    displayName?: string;
    description?: string;
  } = {}
) {
  const uniqueId = generateUniqueId();

  // Permission names must follow regex: ^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$
  // Each segment must start with a letter, so we prefix uniqueId with 'p'
  const permission = await prisma.permission.create({
    data: {
      name: options.name || `test.permission.p${uniqueId}`,
      displayName: options.displayName || `Test Permission ${uniqueId}`,
      description: options.description || "Test permission for testing",
      serviceId: TEST_SERVICE_ID,
    },
  });

  return permission;
}

// Create admin user with admin role
export async function createAdminUser() {
  const user = await createTestUser({ name: "Admin User" });

  // Core's own `admin` role, registered when the suite starts.
  const adminRole = await prisma.role.findFirstOrThrow({
    where: { name: "admin", serviceId: CORE_SERVICE_ID },
  });

  // Assign admin role to user
  await prisma.userRole.create({
    data: {
      userId: user.id,
      roleId: adminRole.id,
    },
  });

  return user;
}

interface AuthorizeResponse {
  redirect_url?: string;
  error?: string;
  error_description?: string;
}

interface ConsentResponse {
  redirect_url?: string;
  error?: string;
  error_description?: string;
}

// Get access token for a user (simulates login flow)
/**
 * An access token issued to core's own UI, from a login that just happened:
 * what the routes behind requireCoreUi and requireRecentLogin accept.
 */
export async function getUiAccessTokenForUser(user: {
  id: string;
  email: string;
  plainPassword: string;
}): Promise<string> {
  const client = await prisma.oAuthClient.findFirstOrThrow({
    where: { clientId: LOGIN_CLIENT.clientId },
    select: { id: true, clientId: true, redirectUris: true },
  });
  return getAccessTokenForUser(user, client, "openid profile email");
}

export async function getAccessTokenForUser(
  user: { id: string; email: string; plainPassword: string },
  client: { clientId: string; id: string; redirectUris?: string[] },
  scope: string = ["openid profile email", ...ALL_CORE_SCOPES].join(" ")
): Promise<string> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateUniqueId();
  const redirectUri =
    client.redirectUris?.[0] || "http://localhost:3000/callback";

  // Step 1: GET /oauth/authorize to get session cookie
  const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", client.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", scope);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const getResponse = await fetch(authorizeUrl.toString(), {
    method: "GET",
    redirect: "manual",
  });

  // Extract the session cookie from the GET response
  // Cookie name is tereo_session_{clientId}
  const setCookieHeader = getResponse.headers.get("set-cookie") || "";
  const sessionCookieMatch = setCookieHeader.match(
    /tereo_session_[^=]+=([^;]+)/
  );
  const sessionCookie = sessionCookieMatch ? sessionCookieMatch[0] : "";

  if (!sessionCookie) {
    throw new Error(
      `Failed to get session cookie from authorize GET. Response status: ${getResponse.status}, Headers: ${setCookieHeader}`
    );
  }

  // Step 2: POST credentials with the session cookie
  const authResponse = await fetch(`${BASE_URL}/oauth/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: redirectUri,
      state,
      scope,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      email: user.email,
      password: user.plainPassword,
    }),
    redirect: "manual",
  });

  const authData = (await authResponse.json()) as AuthorizeResponse;

  if (authData.error) {
    throw new Error(
      `Authorization failed: ${authData.error} - ${authData.error_description}`
    );
  }

  if (!authData.redirect_url) {
    throw new Error("No redirect_url in authorization response");
  }

  let authCode: string | null = null;

  // Check if we have a code in the redirect URL
  if (authData.redirect_url.includes("code=")) {
    const url = new URL(authData.redirect_url);
    authCode = url.searchParams.get("code");
  } else if (authData.redirect_url.includes("/consent")) {
    // Need to handle consent - extract session and approve
    const consentUrl = new URL(authData.redirect_url);
    const consentSessionId = consentUrl.searchParams.get("session");

    if (!consentSessionId) {
      throw new Error("No session in consent redirect URL");
    }

    // Extract consent cookie from auth response
    // Cookie name is tereo_consent_session_{clientId}
    const authCookieHeader = authResponse.headers.get("set-cookie") || "";
    const consentCookieMatch = authCookieHeader.match(
      /tereo_consent_session_[^=]+=([^;]+)/
    );
    const consentCookie = consentCookieMatch ? consentCookieMatch[0] : "";

    const consentResponse = await fetch(`${BASE_URL}/oauth/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: consentCookie,
      },
      body: JSON.stringify({
        session_token: consentSessionId,
        approved: true,
      }),
      redirect: "manual",
    });

    const consentData = (await consentResponse.json()) as ConsentResponse;

    if (consentData.error) {
      throw new Error(
        `Consent failed: ${consentData.error} - ${consentData.error_description}`
      );
    }

    if (
      consentData.redirect_url &&
      consentData.redirect_url.includes("code=")
    ) {
      const url = new URL(consentData.redirect_url);
      authCode = url.searchParams.get("code");
    }
  }

  if (!authCode) {
    throw new Error(
      `Failed to obtain authorization code. Auth redirect: ${authData.redirect_url}`
    );
  }

  // Step 3: Exchange code for token
  const tokenResponse = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      code_verifier: codeVerifier,
    }),
  });

  const tokenData = (await tokenResponse.json()) as TokenResponse;

  if (!tokenData.access_token) {
    throw new Error(
      `Failed to obtain access token: ${JSON.stringify(tokenData)}`
    );
  }

  return tokenData.access_token;
}

// Resolve a user's permission live via /oauth/check-permission (client
// credentials over Basic auth). Unlike a minted access token — which embeds
// permissions at issue time — this reflects the current DB state.
export async function checkUserPermission(
  client: { clientId: string; plainSecret: string | null },
  userId: string,
  permission: string
): Promise<boolean> {
  const header = `Basic ${Buffer.from(
    `${client.clientId}:${client.plainSecret}`
  ).toString("base64")}`;

  const response = await fetch(`${BASE_URL}/oauth/check-permission`, {
    method: "POST",
    headers: { Authorization: header, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, permission }),
  });

  if (response.status !== HTTP_STATUS.OK) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      `check-permission failed: ${response.status} ${JSON.stringify(data)}`
    );
  }

  const data = (await response.json()) as { granted: boolean };
  return data.granted;
}

// =============================================================================
// ORGANIZATION HELPERS
// =============================================================================

export interface OrganizationResponse {
  id: string;
  name: string;
  slug: string;
  code: string;
  isDefault: boolean;
  isActive: boolean;
  archivedAt: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMemberResponse {
  id: string;
  memberRole: "owner" | "admin" | "member";
  createdAt: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    isActive: boolean;
  };
}

export interface OrganizationListResponse {
  data: OrganizationResponse[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

export interface OrganizationMembersResponse {
  organizationId: string;
  members: OrganizationMemberResponse[];
}

export interface MemberRolesResponse {
  organizationId: string;
  userId: string;
  roles: Array<{
    id: string;
    name: string;
    displayName: string | null;
    expiresAt: string | null;
  }>;
}

export async function createTestOrganization(
  adminToken: string,
  options: {
    name?: string;
    slug?: string;
    code?: string;
  } = {}
): Promise<OrganizationResponse> {
  const uniqueId = generateUniqueId();

  const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: options.name || `Test Org ${uniqueId}`,
      slug: options.slug || `test-org-${uniqueId}`,
      code: options.code || uniqueId.slice(0, 6).toUpperCase(),
    }),
  });

  if (response.status !== 201) {
    const data = await response.json();
    throw new Error(
      `Failed to create test organization: ${response.status} ${JSON.stringify(data)}`
    );
  }

  return response.json() as Promise<OrganizationResponse>;
}

export async function addTestOrgMember(
  adminToken: string,
  orgId: string,
  userId: string,
  memberRole: "owner" | "admin" | "member" = "member"
): Promise<OrganizationMemberResponse> {
  const response = await fetch(
    `${BASE_URL}/v1/admin/organizations/${orgId}/members`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId, memberRole }),
    }
  );

  if (response.status !== 201) {
    const data = await response.json();
    throw new Error(
      `Failed to add org member: ${response.status} ${JSON.stringify(data)}`
    );
  }

  return response.json() as Promise<OrganizationMemberResponse>;
}

// A user without TOTP holding a role that requires it, so the password step
// of /oauth/authorize sends them to 2FA setup.
export async function createUserRequiringTotpSetup() {
  const user = await createTestUser();
  const role = await createTestRole();
  await prisma.role.update({
    where: { id: role.id },
    data: { requires2fa: true },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user;
}

export interface TotpSetupGrantLogin {
  setupUrl: URL;
  setupGrant: string;
  // `name=value` for the Cookie header
  grantCookie: string;
  codeVerifier: string;
  state: string;
}

// Drives GET + POST /oauth/authorize up to the redirect to 2FA setup.
export async function loginToTotpSetup(
  user: { email: string; plainPassword: string },
  client: { clientId: string; redirectUris?: string[] },
  scope: string = "openid profile email"
): Promise<TotpSetupGrantLogin> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateUniqueId();
  const redirectUri =
    client.redirectUris?.[0] || "http://localhost:3000/callback";

  const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", client.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", scope);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const getResponse = await fetch(authorizeUrl.toString(), {
    redirect: "manual",
  });
  const sessionCookie =
    (getResponse.headers.get("set-cookie") || "").match(
      /tereo_session_[^=]+=[^;]+/
    )?.[0] ?? "";

  const authResponse = await fetch(`${BASE_URL}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie },
    body: JSON.stringify({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: redirectUri,
      state,
      scope,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      email: user.email,
      password: user.plainPassword,
    }),
  });
  const authData = (await authResponse.json()) as { redirect_url?: string };
  if (!authData.redirect_url?.includes("/login/2fa/setup")) {
    throw new Error(
      `Expected a redirect to 2FA setup, got ${JSON.stringify(authData)}`
    );
  }

  const setupUrl = new URL(authData.redirect_url);
  const grantCookie =
    (authResponse.headers.get("set-cookie") || "").match(
      /tereo_2fa_setup_grant_[^=]+=[^;]+/
    )?.[0] ?? "";

  return {
    setupUrl,
    setupGrant: setupUrl.searchParams.get("setup_grant") ?? "",
    grantCookie,
    codeVerifier,
    state,
  };
}

export function startTotpSetup(
  body: Record<string, unknown>,
  cookie?: string
): Promise<Response> {
  return fetch(`${BASE_URL}/oauth/totp/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}
