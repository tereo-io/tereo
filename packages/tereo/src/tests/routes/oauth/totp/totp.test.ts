// @module-tag int
// @module-tag auth
import { createTestRole, createTestUser } from "../../../support/auth/users.js";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { BASE_URL, HTTP_STATUS } from "../../../support/auth/constants.js";
import { hashFlowToken, hashPassword } from "../../../../utils/crypto.js";
import { getAccessTokenForUser } from "../../../support/auth/login.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { generateTotpCode } from "../../../support/auth/crypto.js";
import { getRedisClient } from "../../../../utils/redis.js";
import { decodeJwt } from "../../../support/auth/tokens.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { createHash, randomBytes } from "node:crypto";
import {
  loginToTotpSetup,
  startTotpSetup,
  createUserRequiringTotpSetup,
} from "../../../support/auth/totpSetup.js";
import {
  absorbCookies,
  cookieHeader,
  newPkce,
} from "../../../support/browserLogin.js";
import {
  generateTotpSecret,
  encryptTotpSecret,
} from "../../../../utils/totp.js";

describe("/oauth/totp", () => {
  describe("OAuth TOTP Endpoints", () => {
    interface TotpSetupResponse {
      secret?: string;
      qrCodeUri?: string;
      setupToken?: string;
      expiresAt?: string;
      error?: string;
      error_description?: string;
    }

    let testClient: Awaited<ReturnType<typeof createTestClient>>;

    beforeAll(async () => {
      testClient = await createTestClient();
    });

    describe("POST /oauth/totp/setup", () => {
      it("redirects to setup with a grant, not the user id, and stores only its hash", async () => {
        const user = await createUserRequiringTotpSetup();
        const login = await loginToTotpSetup(user, testClient);

        expect(login.setupUrl.searchParams.has("user_id")).toBe(false);
        expect(login.setupUrl.toString()).not.toContain(user.id);
        expect(login.setupGrant.length).toBeGreaterThanOrEqual(43);
        expect(login.grantCookie).toContain(login.setupGrant);

        const grants = await prisma.totpSetupGrant.findMany({
          where: { userId: user.id },
        });
        expect(grants).toHaveLength(1);
        expect(grants[0].tokenHash).not.toBe(login.setupGrant);
        expect(grants[0].clientId).toBe(testClient.id);
        expect(grants[0].state).toBe(login.state);
      });

      it("returns setup data for the user the grant was issued to", async () => {
        const user = await createUserRequiringTotpSetup();
        const login = await loginToTotpSetup(user, testClient);

        const response = await startTotpSetup(
          { setup_grant: login.setupGrant },
          login.grantCookie
        );
        const data = (await response.json()) as TotpSetupResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.secret!.length).toBeGreaterThan(10);
        expect(data.qrCodeUri).toContain("otpauth://totp/");
        expect(data.qrCodeUri).toContain(encodeURIComponent(user.email));
        expect(data.setupToken).toBeDefined();
        expect(data.expiresAt).toBeDefined();

        const session = await prisma.totpSetupSession.findUniqueOrThrow({
          where: { tokenHash: hashFlowToken(data.setupToken!) },
        });
        expect(session.userId).toBe(user.id);
        expect(session.clientId).toBe(testClient.id);
        expect(session.state).toBe(login.state);

        const entry = await prisma.auditLogEntry.findFirst({
          where: {
            entityType: "User",
            entityId: user.id,
            metadata: { path: ["action"], equals: "totp_setup_started" },
          },
        });
        expect(entry).toMatchObject({ action: "UPDATE", userId: user.id });
        expect(entry?.metadata).toMatchObject({
          clientId: testClient.clientId,
        });
      });
    });

    describe("POST /oauth/totp/setup/verify", () => {
      it("ends the sessions opened with the password alone", async () => {
        const user = await createTestUser();
        // Signed in before 2FA was required of the user.
        const earlier = await getAccessTokenForUser(
          user,
          testClient,
          "openid offline_access core:account"
        );
        const role = await createTestRole();
        await prisma.role.update({
          where: { id: role.id },
          data: { requires2fa: true },
        });
        await prisma.userRole.create({
          data: { userId: user.id, roleId: role.id },
        });

        const login = await loginToTotpSetup(user, testClient);
        const started = await startTotpSetup(
          { setup_grant: login.setupGrant },
          login.grantCookie
        );
        const setup = (await started.json()) as TotpSetupResponse;
        const verify = await fetch(`${BASE_URL}/oauth/totp/setup/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            setup_token: setup.setupToken,
            totp_code: generateTotpCode(setup.secret!),
          }),
        });
        expect(verify.status).toBe(HTTP_STATUS.OK);

        const me = await fetch(`${BASE_URL}/v1/account/me`, {
          headers: { Authorization: `Bearer ${earlier}` },
        });
        expect(me.status).toBe(HTTP_STATUS.UNAUTHORIZED);
        expect(
          await prisma.refreshToken.count({
            where: { userId: user.id, revokedAt: null },
          })
        ).toBe(0);
      });
    });
  });

  describe("MFA Authentication Flow", () => {
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
        headers: {
          "Content-Type": "application/json",
          Cookie: challenge.cookie,
        },
        body: JSON.stringify({
          session_token: challenge.sessionToken,
          ...body,
        }),
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
      // An unused code, so a wrong one is checked rather than refused outright.
      await prisma.recoveryCode.create({
        data: {
          userId: user.id,
          codeHash: await hashPassword(randomBytes(6).toString("hex")),
        },
      });
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
        await prisma.recoveryCode.deleteMany({
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

    describe("Recovery code flow", () => {
      /** A user with TOTP and the given recovery codes (plain; stored hashed). */
      async function createRecoveryUser(
        codes: { code: string; used?: boolean }[]
      ) {
        const uniqueId = randomBytes(8).toString("hex");
        const user = await prisma.user.create({
          data: {
            email: `recovery-test-user-${uniqueId}@test.local`,
            passwordHash: await hashPassword(TEST_USER_PASSWORD),
            name: "Recovery Test User",
            isActive: true,
            totpSecret: encryptTotpSecret(generateTotpSecret()),
            totpEnabled: true,
            totpEnabledAt: new Date(),
          },
        });
        for (const { code, used } of codes) {
          await prisma.recoveryCode.create({
            data: {
              userId: user.id,
              codeHash: await hashPassword(code.replace(/-/g, "")),
              usedAt: used ? new Date() : null,
            },
          });
        }
        return user;
      }

      const deleteRecoveryUser = async (userId: string) => {
        await prisma.userSession.deleteMany({ where: { userId } });
        await prisma.consentSession.deleteMany({ where: { userId } });
        await prisma.authorizationCode.deleteMany({ where: { userId } });
        await prisma.refreshToken.deleteMany({ where: { userId } });
        await prisma.recoveryCode.deleteMany({ where: { userId } });
        await prisma.user.delete({ where: { id: userId } }).catch(() => {});
      };

      it("should accept recovery code as alternative to TOTP", async () => {
        const recoveryCodes = [
          `REC${randomBytes(4).toString("hex").toUpperCase()}`,
          `REC${randomBytes(4).toString("hex").toUpperCase()}`,
        ];
        const user = await createRecoveryUser(
          recoveryCodes.map((code) => ({ code }))
        );

        try {
          const challenge = await startMfaLogin(user.email, "openid");
          // Lowercase and dashed: the endpoint normalizes before comparing.
          const entered = `${recoveryCodes[0].slice(0, 5)}-${recoveryCodes[0].slice(5)}`;
          const recoveryResponse = await submitSecondFactor(
            "recovery",
            challenge,
            { recovery_code: entered.toLowerCase() }
          );

          const tokenData = await finishMfaLogin(challenge, recoveryResponse);
          const idToken = decodeJwt(tokenData.id_token!);
          expect(idToken.amr).toEqual(["pwd", "recovery"]);
          expect(idToken.acr).toBe("urn:auth-service:mfa");

          // Exactly the code entered is consumed.
          const used = await prisma.recoveryCode.findMany({
            where: { userId: user.id, usedAt: { not: null } },
          });
          expect(used).toHaveLength(1);
        } finally {
          await deleteRecoveryUser(user.id);
        }
      });

      it("should reject already-used recovery code", async () => {
        const usedRecoveryCode = `USED${randomBytes(4)
          .toString("hex")
          .toUpperCase()}`;
        const user = await createRecoveryUser([
          { code: usedRecoveryCode, used: true },
        ]);

        try {
          const challenge = await startMfaLogin(user.email, "openid");
          const recoveryResponse = await submitSecondFactor(
            "recovery",
            challenge,
            { recovery_code: usedRecoveryCode }
          );

          // Its only code is spent, so none is left to match.
          expect(recoveryResponse.status).toBe(HTTP_STATUS.BAD_REQUEST);
          const recoveryData = (await recoveryResponse.json()) as ErrorResponse;
          expect(recoveryData.error).toBe("no_recovery_codes");
        } finally {
          await deleteRecoveryUser(user.id);
        }
      });

      it("should reject an already-used recovery code among unused ones", async () => {
        const usedCode = `USED${randomBytes(4).toString("hex").toUpperCase()}`;
        const user = await createRecoveryUser([
          { code: usedCode, used: true },
          { code: `REC${randomBytes(4).toString("hex").toUpperCase()}` },
        ]);

        try {
          const challenge = await startMfaLogin(user.email, "openid");
          const recoveryResponse = await submitSecondFactor(
            "recovery",
            challenge,
            { recovery_code: usedCode }
          );

          expect(recoveryResponse.status).toBe(HTTP_STATUS.UNAUTHORIZED);
          const recoveryData = (await recoveryResponse.json()) as ErrorResponse;
          expect(recoveryData.error).toBe("invalid_code");
        } finally {
          await deleteRecoveryUser(user.id);
        }
      });

      it("should reject invalid recovery code", async () => {
        const challenge = await startMfaLogin(TEST_MFA_USER_EMAIL, "openid");
        const recoveryResponse = await submitSecondFactor(
          "recovery",
          challenge,
          {
            recovery_code: "INVALID-RECOVERY-CODE",
          }
        );

        expect(recoveryResponse.status).toBe(HTTP_STATUS.UNAUTHORIZED);
        const recoveryData = (await recoveryResponse.json()) as ErrorResponse;
        expect(recoveryData.error).toBe("invalid_code");
      });
    });
  });

  describe("TOTP setup during login", () => {
    const REDIRECT_URI = "http://localhost:3000/callback";

    type Client = Awaited<ReturnType<typeof createTestClient>>;

    let publicClient: Client;

    beforeAll(async () => {
      publicClient = await createTestClient({ redirectUris: [REDIRECT_URI] });
    });

    // Five attempts per user (credentialFailureLimits.test.ts covers the
    // lockout): four wrong codes leave room for the right one.
    it("counts wrong codes toward the lockout, clears them on success, and audits a spent recovery code", async () => {
      const totpUser = await createUserRequiringTotpSetup();
      const login = await loginToTotpSetup(totpUser, publicClient);
      const started = await startTotpSetup(
        { setup_grant: login.setupGrant },
        login.grantCookie
      );
      expect(started.status).toBe(200);
      const { secret, setupToken } = (await started.json()) as {
        secret: string;
        setupToken: string;
      };
      const right = generateTotpCode(secret);
      const wrong = String((Number(right) + 500_000) % 1_000_000).padStart(
        6,
        "0"
      );

      const verify = (totp_code: string) =>
        fetch(`${BASE_URL}/oauth/totp/setup/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ setup_token: setupToken, totp_code }),
        });
      const failures = async () => {
        const redis = getRedisClient();
        const keys = await redis.keys("rl:totp:setup:fail:*");
        const values = await Promise.all(keys.map((k) => redis.get(k)));
        return values.map(Number).reduce((sum, n) => sum + n, 0);
      };

      for (let i = 0; i < 4; i++) {
        expect((await verify(wrong)).status).toBe(401);
      }
      expect(await failures()).toBe(4);
      const enrolled = await verify(right);
      expect(enrolled.status).toBe(200);
      expect(await failures()).toBe(0);
      const { recoveryCodes } = (await enrolled.json()) as {
        recoveryCodes: string[];
      };

      // Signing in again, a recovery code stands in for the TOTP code, and
      // spending it is audited.
      const jar = new Map<string, string>();
      const pkce = newPkce();
      const params = {
        response_type: "code",
        client_id: publicClient.clientId,
        redirect_uri: REDIRECT_URI,
        state: pkce.state,
        scope: "openid",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      };
      const start = await fetch(
        `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
        { redirect: "manual" }
      );
      absorbCookies(jar, start);
      const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader(jar),
        },
        body: JSON.stringify({
          ...params,
          email: totpUser.email,
          password: totpUser.plainPassword,
        }),
      });
      absorbCookies(jar, submit);
      const { redirect_url } = (await submit.json()) as {
        redirect_url: string;
      };
      const session = new URL(redirect_url).searchParams.get("session");
      expect(new URL(redirect_url).pathname).toMatch(/\/login\/2fa$/);

      const recovered = await fetch(`${BASE_URL}/oauth/totp/recovery`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader(jar),
        },
        body: JSON.stringify({
          session_token: session,
          recovery_code: recoveryCodes[0],
        }),
      });
      expect(recovered.status).toBe(200);

      const entries = await prisma.auditLogEntry.findMany({
        where: { entityType: "User", entityId: totpUser.id },
      });
      const used = entries.filter(
        (e) =>
          (e.metadata as { action?: string } | null)?.action ===
          "recovery_code_used"
      );
      expect(used).toHaveLength(1);
      expect(used[0].userId).toBe(totpUser.id);
    });
  });
});
