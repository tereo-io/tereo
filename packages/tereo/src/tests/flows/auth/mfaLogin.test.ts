// @module-tag int
// @module-tag auth
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { generateTotpSecret, encryptTotpSecret } from "../../../utils/totp.js";
import { BASE_URL, HTTP_STATUS } from "../../support/auth/constants.js";
import { generateTotpCode } from "../../support/auth/crypto.js";
import { decodeJwt } from "../../support/auth/tokens.js";
import { hashPassword } from "../../../utils/crypto.js";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../../../utils/db/prisma.js";
import {
  startTotpSetup,
  loginToTotpSetup,
  createUserRequiringTotpSetup,
} from "../../support/auth/totpSetup.js";

// Test entity variables
let TEST_CLIENT_ID = "";
let TEST_CLIENT_DB_ID = "";
let TEST_MFA_USER_ID = "";
let TEST_MFA_USER_EMAIL = "";
const TEST_USER_PASSWORD = "TestPassword123!";
const TEST_REDIRECT_URI = "http://localhost:3000/mfa-callback";
let TOTP_SECRET = "";

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

// Helper functions
function generateCodeVerifier(): string {
  return randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// Type definitions
interface AuthorizeResponse {
  redirect_url?: string;
  error?: string;
  error_description?: string;
}

interface MfaChallenge {
  codeVerifier: string;
  sessionToken: string;
  /** The `tereo_2fa_session_{client_id}` cookie pair. */
  cookie: string;
}

/**
 * Password login for a user with TOTP: authorize answers with the 2FA page
 * and its session, set in a cookie as well.
 */
async function startMfaLogin(
  email: string,
  scope = "openid profile email"
): Promise<MfaChallenge> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(16).toString("hex");
  const params = {
    response_type: "code",
    client_id: TEST_CLIENT_ID,
    redirect_uri: TEST_REDIRECT_URI,
    state,
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  };

  const getResponse = await fetch(
    `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
    { redirect: "manual" }
  );
  expect(getResponse.status).toBe(HTTP_STATUS.FOUND);
  const sessionCookie =
    (getResponse.headers.get("set-cookie") || "").match(
      /tereo_session_[^=]+=[^;]+/
    )?.[0] ?? "";
  expect(sessionCookie).toBeTruthy();

  const authResponse = await fetch(`${BASE_URL}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie },
    body: JSON.stringify({
      ...params,
      email,
      password: TEST_USER_PASSWORD,
    }),
  });
  expect(authResponse.status).toBe(HTTP_STATUS.OK);
  const authData = (await authResponse.json()) as AuthorizeResponse;
  const challengeUrl = new URL(authData.redirect_url!);
  expect(challengeUrl.pathname).toBe("/login/2fa");
  const sessionToken = challengeUrl.searchParams.get("session");
  expect(sessionToken).toBeTruthy();
  const cookie =
    (authResponse.headers.get("set-cookie") || "").match(
      /tereo_2fa_session_[^=]+=[^;]+/
    )?.[0] ?? "";
  expect(cookie).toBeTruthy();

  return { codeVerifier, sessionToken: sessionToken!, cookie };
}

/** POSTs to `/oauth/totp/verify` or `/oauth/totp/recovery`. */
function submitSecondFactor(
  path: "verify" | "recovery",
  challenge: MfaChallenge,
  body: Record<string, unknown>
) {
  return fetch(`${BASE_URL}/oauth/totp/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: challenge.cookie },
    body: JSON.stringify({ session_token: challenge.sessionToken, ...body }),
  });
}

/**
 * From a successful second factor through consent to tokens: the user
 * belongs to no organization, so the next stop is the consent screen.
 */
async function finishMfaLogin(
  challenge: MfaChallenge,
  factorResponse: Response
): Promise<TokenResponse> {
  expect(factorResponse.status).toBe(HTTP_STATUS.OK);
  const factorData = (await factorResponse.json()) as TotpVerifyResponse;
  const consentUrl = new URL(factorData.redirect_url!);
  expect(consentUrl.pathname).toBe("/consent");
  const consentCookie =
    (factorResponse.headers.get("set-cookie") || "").match(
      /tereo_consent_session_[^=]+=[^;]+/
    )?.[0] ?? "";
  expect(consentCookie).toBeTruthy();

  const consentResponse = await fetch(`${BASE_URL}/oauth/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: consentCookie },
    body: JSON.stringify({
      session_token: consentUrl.searchParams.get("session"),
      approved: true,
    }),
  });
  expect(consentResponse.status).toBe(HTTP_STATUS.OK);
  const consentData = (await consentResponse.json()) as AuthorizeResponse;
  const code = new URL(consentData.redirect_url!).searchParams.get("code");
  expect(code).toBeTruthy();

  const tokenResponse = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT_URI,
      client_id: TEST_CLIENT_ID,
      code_verifier: challenge.codeVerifier,
    }),
  });
  expect(tokenResponse.status).toBe(HTTP_STATUS.OK);
  return (await tokenResponse.json()) as TokenResponse;
}

interface TotpVerifyResponse {
  redirect_url?: string;
  error?: string;
  error_description?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface TotpSetupResponse {
  secret?: string;
  qrCodeUri?: string;
  setupToken?: string;
  expiresAt?: string;
  error?: string;
  error_description?: string;
}

describe("MFA Authentication Flow", () => {
  beforeAll(async () => {
    // Check server is running
    const response = await fetch(
      `${BASE_URL}/.well-known/openid-configuration`
    );
    if (!response.ok) {
      throw new Error(`Server not running at ${BASE_URL}`);
    }

    // Create test entities
    const uniqueId = randomBytes(8).toString("hex");
    TEST_CLIENT_ID = `test-mfa-client-${uniqueId}`;
    TEST_MFA_USER_EMAIL = `test-mfa-user-${uniqueId}@test.local`;

    // Create test owner user
    const ownerPasswordHash = await hashPassword("TestPassword123!");
    const testOwner = await prisma.user.create({
      data: {
        email: `test-mfa-owner-${uniqueId}@test.local`,
        passwordHash: ownerPasswordHash,
        name: "MFA Test Owner",
        isActive: true,
      },
    });

    // Create test client
    const client = await prisma.oAuthClient.create({
      data: {
        clientId: TEST_CLIENT_ID,
        clientSecret: null,
        clientType: "public",
        name: `MFA Test Client ${uniqueId}`,
        redirectUris: [TEST_REDIRECT_URI],
        postLogoutRedirectUris: [],
        scopes: ["openid", "profile", "email", "offline_access"],
        grantTypes: ["authorization_code", "refresh_token"],
        audience: [],
        ownerId: testOwner.id,
      },
    });
    TEST_CLIENT_DB_ID = client.id;

    // Create test user with TOTP enabled
    const passwordHash = await hashPassword(TEST_USER_PASSWORD);

    // Generate TOTP secret using internal function
    TOTP_SECRET = generateTotpSecret();

    const user = await prisma.user.create({
      data: {
        email: TEST_MFA_USER_EMAIL,
        passwordHash,
        name: "MFA Test User",
        isActive: true,
        totpSecret: encryptTotpSecret(TOTP_SECRET),
        totpEnabled: true,
        totpEnabledAt: new Date(),
      },
    });
    TEST_MFA_USER_ID = user.id;
  });

  // The shared MFA user signs in with a code in several tests; each starts
  // with none spent, so two in one 30s step don't trip the replay check.
  beforeEach(async () => {
    if (TEST_MFA_USER_ID) {
      await prisma.user.update({
        where: { id: TEST_MFA_USER_ID },
        data: { totpLastWindow: null },
      });
    }
  });

  afterAll(async () => {
    // Cleanup test entities
    if (TEST_MFA_USER_ID) {
      await prisma.userSession.deleteMany({
        where: { userId: TEST_MFA_USER_ID },
      });
      await prisma.consentSession.deleteMany({
        where: { userId: TEST_MFA_USER_ID, clientId: TEST_CLIENT_DB_ID },
      });
      await prisma.authorizationCode.deleteMany({
        where: { userId: TEST_MFA_USER_ID, clientId: TEST_CLIENT_DB_ID },
      });
      await prisma.refreshToken.deleteMany({
        where: { userId: TEST_MFA_USER_ID },
      });
      await prisma.user
        .delete({ where: { id: TEST_MFA_USER_ID } })
        .catch(() => {});
    }
    if (TEST_CLIENT_DB_ID) {
      await prisma.oAuthClient
        .delete({ where: { id: TEST_CLIENT_DB_ID } })
        .catch(() => {});
    }
  });

  describe("OAuth flow with MFA-enabled user", () => {
    it("should require MFA verification for user with TOTP enabled", async () => {
      const challenge = await startMfaLogin(TEST_MFA_USER_EMAIL);
      expect(challenge.sessionToken.length).toBeGreaterThan(0);
    });

    it("should complete full MFA flow with valid TOTP code", async () => {
      const challenge = await startMfaLogin(TEST_MFA_USER_EMAIL);
      const totpResponse = await submitSecondFactor("verify", challenge, {
        totp_code: generateTotpCode(TOTP_SECRET),
      });

      const tokenData = await finishMfaLogin(challenge, totpResponse);
      expect(tokenData.access_token).toBeDefined();
      expect(decodeJwt(tokenData.id_token!).sub).toBe(TEST_MFA_USER_ID);
    });

    it("should reject invalid TOTP code during MFA flow", async () => {
      const challenge = await startMfaLogin(TEST_MFA_USER_EMAIL, "openid");
      const validCode = generateTotpCode(TOTP_SECRET);
      const totpResponse = await submitSecondFactor("verify", challenge, {
        totp_code: validCode === "000000" ? "111111" : "000000",
      });

      const totpData = (await totpResponse.json()) as TotpVerifyResponse;

      expect(totpResponse.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(totpData.error).toBe("invalid_code");
      expect(totpData.error_description).toBeDefined();
    });

    it("should return 400 with invalid_session for invalid MFA session token", async () => {
      const response = await fetch(`${BASE_URL}/oauth/totp/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_token: "invalid-session-token",
          totp_code: "123456",
        }),
      });

      const data = (await response.json()) as TotpVerifyResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe("invalid_session");
      expect(data.error_description).toBeDefined();
    });

    it("should return 400 for missing TOTP code", async () => {
      const challenge = await startMfaLogin(TEST_MFA_USER_EMAIL, "openid");
      const response = await submitSecondFactor("verify", challenge, {});

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("invalid_request");
    });
  });

  describe("TOTP setup during OAuth flow", () => {
    it("enrols through authorize, setup and verify, then logs in with the new factor", async () => {
      const user = await createUserRequiringTotpSetup();
      const client = {
        clientId: TEST_CLIENT_ID,
        redirectUris: [TEST_REDIRECT_URI],
      };

      try {
        const login = await loginToTotpSetup(user, client);
        const setupResponse = await startTotpSetup(
          { setup_grant: login.setupGrant },
          login.grantCookie
        );
        const setupData = (await setupResponse.json()) as TotpSetupResponse;
        expect(setupResponse.status).toBe(HTTP_STATUS.OK);

        const setupVerify = await fetch(`${BASE_URL}/oauth/totp/setup/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            setup_token: setupData.setupToken,
            totp_code: generateTotpCode(setupData.secret!),
          }),
        });
        expect(setupVerify.status).toBe(HTTP_STATUS.OK);

        const codeVerifier = generateCodeVerifier();
        const state = randomBytes(16).toString("hex");
        const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", TEST_CLIENT_ID);
        authorizeUrl.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("scope", "openid profile email");
        authorizeUrl.searchParams.set(
          "code_challenge",
          generateCodeChallenge(codeVerifier)
        );
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
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionCookie,
          },
          body: JSON.stringify({
            response_type: "code",
            client_id: TEST_CLIENT_ID,
            redirect_uri: TEST_REDIRECT_URI,
            state,
            scope: "openid profile email",
            code_challenge: generateCodeChallenge(codeVerifier),
            code_challenge_method: "S256",
            email: user.email,
            password: user.plainPassword,
          }),
        });
        const authData = (await authResponse.json()) as AuthorizeResponse;
        const challengeUrl = new URL(authData.redirect_url!);
        expect(challengeUrl.pathname).toBe("/login/2fa");
        const totpCookie =
          (authResponse.headers.get("set-cookie") || "").match(
            /tereo_2fa_session_[^=]+=[^;]+/
          )?.[0] ?? "";

        const totpResponse = await fetch(`${BASE_URL}/oauth/totp/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: totpCookie },
          body: JSON.stringify({
            session_token: challengeUrl.searchParams.get("session"),
            totp_code: generateTotpCode(setupData.secret!, 1),
          }),
        });
        const totpData = (await totpResponse.json()) as TotpVerifyResponse;
        expect(totpResponse.status).toBe(HTTP_STATUS.OK);
        const consentUrl = new URL(totpData.redirect_url!);
        expect(consentUrl.pathname).toBe("/consent");
        const consentCookie =
          (totpResponse.headers.get("set-cookie") || "").match(
            /tereo_consent_session_[^=]+=[^;]+/
          )?.[0] ?? "";

        const consentResponse = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: consentCookie,
          },
          body: JSON.stringify({
            session_token: consentUrl.searchParams.get("session"),
            approved: true,
          }),
        });
        const consentData = (await consentResponse.json()) as AuthorizeResponse;
        const code = new URL(consentData.redirect_url!).searchParams.get(
          "code"
        );
        expect(code).toBeTruthy();

        const tokenResponse = await fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            redirect_uri: TEST_REDIRECT_URI,
            client_id: TEST_CLIENT_ID,
            code_verifier: codeVerifier,
          }),
        });
        const tokenData = (await tokenResponse.json()) as TokenResponse;
        expect(tokenResponse.status).toBe(HTTP_STATUS.OK);
        expect(tokenData.access_token).toBeDefined();
        const idToken = decodeJwt(tokenData.id_token!);
        expect(idToken.sub).toBe(user.id);
        expect(idToken.amr).toEqual(expect.arrayContaining(["pwd", "otp"]));
      } finally {
        await prisma.userSession.deleteMany({ where: { userId: user.id } });
        await prisma.consentSession.deleteMany({ where: { userId: user.id } });
        await prisma.authorizationCode.deleteMany({
          where: { userId: user.id },
        });
        await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
      }
    });
  });

  describe("acr_values and amr claims", () => {
    it("should request MFA level authentication with acr_values=urn:auth-service:mfa", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = randomBytes(16).toString("hex");

      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", TEST_CLIENT_ID);
      authorizeUrl.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("acr_values", "urn:auth-service:mfa");

      const response = await fetch(authorizeUrl.toString(), {
        redirect: "manual",
      });

      // Should redirect to login page with acr_values
      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";
      expect(location).toContain("acr_values");
    });

    it("should request password authentication with acr_values=urn:auth-service:pwd", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = randomBytes(16).toString("hex");

      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", TEST_CLIENT_ID);
      authorizeUrl.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("acr_values", "urn:auth-service:pwd");

      const response = await fetch(authorizeUrl.toString(), {
        redirect: "manual",
      });

      // Should redirect to login page with acr_values
      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";
      expect(location).toContain("acr_values");
    });

    it("should include acr claim in id_token after MFA authentication", async () => {
      const challenge = await startMfaLogin(TEST_MFA_USER_EMAIL);
      const totpResponse = await submitSecondFactor("verify", challenge, {
        totp_code: generateTotpCode(TOTP_SECRET),
      });
      const tokenData = await finishMfaLogin(challenge, totpResponse);

      const payload = decodeJwt(tokenData.id_token!);

      // OIDC Core: acr claim MUST indicate MFA was used after MFA authentication
      expect(payload.acr).toBe("urn:auth-service:mfa");

      // OIDC Core: amr claim MUST be present and include authentication methods used
      expect(payload.amr).toEqual(["pwd", "otp"]);
    });
  });
});
