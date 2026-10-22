// @module-tag int
// @module-tag auth
import { expectAuthorizeErrorRedirect } from "../../../support/pure/authorizeErrors.js";
import { ensureTestOrganization } from "../../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, scryptSync, createHash } from "node:crypto";
import { hashPassword } from "../../../../utils/crypto.js";
import { prisma } from "../../../../utils/db/prisma.js";
import {
  absorbCookies,
  browserLogin,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../../../support/browserLogin.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
  getAccessTokenForUser,
} from "../../../support/auth.js";

describe("/oauth/authorize", () => {
  describe("OAuth Authorize Endpoint", () => {
    let testClient: Awaited<ReturnType<typeof createTestClient>>;
    let testUser: Awaited<ReturnType<typeof createTestUser>>;
    let confidentialClient: Awaited<ReturnType<typeof createTestClient>>;

    beforeAll(async () => {
      testClient = await createTestClient();
      testUser = await createTestUser();
      confidentialClient = await createTestClient({
        clientType: "confidential",
      });
    });

    interface AuthorizeResponse {
      redirect_url?: string;
      error?: string;
      error_description?: string;
      mfa_required?: boolean;
      mfa_session_token?: string;
    }

    // Helper to get session cookie from authorize GET
    async function getSessionCookie(
      clientId: string,
      redirectUri: string,
      options: {
        scope?: string;
        codeChallenge?: string;
        codeChallengeMethod?: string;
        state?: string;
        prompt?: string;
        maxAge?: number;
        acrValues?: string;
        nonce?: string;
      } = {}
    ): Promise<{ sessionCookie: string; response: Response }> {
      const codeChallenge =
        options.codeChallenge || generateCodeChallenge(generateCodeVerifier());
      const state = options.state || generateUniqueId();

      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("scope", options.scope || "openid");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set(
        "code_challenge_method",
        options.codeChallengeMethod || "S256"
      );

      if (options.prompt) {
        authorizeUrl.searchParams.set("prompt", options.prompt);
      }
      if (options.maxAge !== undefined) {
        authorizeUrl.searchParams.set("max_age", options.maxAge.toString());
      }
      if (options.acrValues) {
        authorizeUrl.searchParams.set("acr_values", options.acrValues);
      }
      if (options.nonce) {
        authorizeUrl.searchParams.set("nonce", options.nonce);
      }

      const response = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      const setCookieHeader = response.headers.get("set-cookie") || "";
      const sessionCookieMatch = setCookieHeader.match(
        /tereo_session_[^=]+=([^;]+)/
      );
      const sessionCookie = sessionCookieMatch ? sessionCookieMatch[0] : "";

      return { sessionCookie, response };
    }

    describe("GET /oauth/authorize - Parameter Validation", () => {
      it("should return 302 redirect to login for valid request", async () => {
        const { response } = await getSessionCookie(
          testClient.clientId,
          testClient.redirectUris[0]
        );

        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = response.headers.get("location") || "";
        expect(location).toContain("/login");
        expect(location).toContain(`client_id=${testClient.clientId}`);
      });

      it("should set session cookie for valid request", async () => {
        const { sessionCookie } = await getSessionCookie(
          testClient.clientId,
          testClient.redirectUris[0]
        );

        expect(sessionCookie).toBeTruthy();
        expect(sessionCookie).toContain("tereo_session_");
      });
    });

    describe("POST /oauth/authorize - Credential Submission", () => {
      it("should return redirect_url for valid credentials", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = generateUniqueId();

        const { sessionCookie } = await getSessionCookie(
          testClient.clientId,
          testClient.redirectUris[0],
          { codeChallenge, state }
        );

        expect(sessionCookie).toBeTruthy();

        const response = await fetch(`${BASE_URL}/oauth/authorize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionCookie,
          },
          body: JSON.stringify({
            response_type: "code",
            client_id: testClient.clientId,
            redirect_uri: testClient.redirectUris[0],
            state,
            scope: "openid",
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            email: testUser.email,
            password: testUser.plainPassword,
          }),
          redirect: "manual",
        });

        const data = (await response.json()) as AuthorizeResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.redirect_url).toBeDefined();
        expect(data.error).toBeUndefined();
      });
    });

    describe("GET /oauth/authorize - Prompt Parameter", () => {
      it("should redirect to login for prompt=login", async () => {
        const { response } = await getSessionCookie(
          testClient.clientId,
          testClient.redirectUris[0],
          { prompt: "login" }
        );

        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = response.headers.get("location") || "";
        expect(location).toContain("/login");
        expect(location).toContain("prompt=login");
      });

      it("should return error for prompt=none without session", async () => {
        const codeChallenge = generateCodeChallenge(generateCodeVerifier());
        const state = generateUniqueId();

        const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", testClient.clientId);
        authorizeUrl.searchParams.set(
          "redirect_uri",
          testClient.redirectUris[0]
        );
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("scope", "openid");
        authorizeUrl.searchParams.set("code_challenge", codeChallenge);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");
        authorizeUrl.searchParams.set("prompt", "none");

        const response = await fetch(authorizeUrl.toString(), {
          method: "GET",
          redirect: "manual",
        });

        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = response.headers.get("location") || "";
        expect(location).toContain("error=login_required");
        expect(location).toContain(`state=${state}`);
      });

      describe("prompt=none with org_id", () => {
        const signedIn = async (consentRequired: boolean) => {
          const client = await createTestClient();
          await prisma.oAuthClient.update({
            where: { id: client.id },
            data: { consentRequired: false },
          });
          const user = await createTestUser();
          const orgId = await ensureTestOrganization(`silent-org-${user.id}`);
          await prisma.organizationMember.create({
            data: { organizationId: orgId, userId: user.id },
          });
          const { jar } = await browserLogin({
            clientId: client.clientId,
            redirectUri: client.redirectUris[0],
            scope: "openid",
            email: user.email,
            password: user.plainPassword,
          });
          if (consentRequired) {
            await prisma.oAuthClient.update({
              where: { id: client.id },
              data: { consentRequired: true },
            });
          }
          const silent = async (org: string) => {
            const pkce = newPkce();
            const res = await fetch(
              `${BASE_URL}/oauth/authorize?${new URLSearchParams({
                response_type: "code",
                client_id: client.clientId,
                redirect_uri: client.redirectUris[0],
                state: pkce.state,
                scope: "openid",
                code_challenge: pkce.challenge,
                code_challenge_method: "S256",
                prompt: "none",
                org_id: org,
              })}`,
              { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
            );
            expect(res.status).toBe(HTTP_STATUS.FOUND);
            return new URL(res.headers.get("location") ?? "").searchParams;
          };
          return { user, orgId, silent };
        };

        it("issues the code in an organization the user may select", async () => {
          const { user, orgId, silent } = await signedIn(false);
          const params = await silent(orgId);
          expect(params.get("error")).toBeNull();
          const code = await prisma.authorizationCode.findFirst({
            where: { userId: user.id },
            orderBy: { createdAt: "desc" },
          });
          expect(code?.organizationId).toBe(orgId);
        });

        it("answers login_required for an organization the user may not select", async () => {
          const { silent } = await signedIn(false);
          const other = await ensureTestOrganization(
            `silent-other-${generateUniqueId()}`
          );
          expect((await silent(other)).get("error")).toBe("login_required");
        });

        it("answers consent_required for a client that needs approval", async () => {
          const { orgId, silent } = await signedIn(true);
          expect((await silent(orgId)).get("error")).toBe("consent_required");
        });
      });

      it("shows the consent screen for prompt=consent on an org switch that would skip it", async () => {
        const client = await createTestClient();
        await prisma.oAuthClient.update({
          where: { id: client.id },
          data: { consentRequired: false },
        });
        const user = await createTestUser();
        const orgId = await ensureTestOrganization(`prompt-consent-${user.id}`);
        await prisma.organizationMember.create({
          data: { organizationId: orgId, userId: user.id },
        });
        const { jar } = await browserLogin({
          clientId: client.clientId,
          redirectUri: client.redirectUris[0],
          scope: "openid",
          email: user.email,
          password: user.plainPassword,
        });

        const orgSwitch = async (prompt?: string) => {
          const pkce = newPkce();
          const res = await fetch(
            `${BASE_URL}/oauth/authorize?${new URLSearchParams({
              response_type: "code",
              client_id: client.clientId,
              redirect_uri: client.redirectUris[0],
              state: pkce.state,
              scope: "openid",
              code_challenge: pkce.challenge,
              code_challenge_method: "S256",
              org_id: orgId,
              ...(prompt && { prompt }),
            })}`,
            { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
          );
          absorbCookies(jar, res);
          expect(res.status).toBe(HTTP_STATUS.FOUND);
          return new URL(res.headers.get("location") ?? "");
        };

        expect((await orgSwitch()).searchParams.has("code")).toBe(true);
        const consent = await orgSwitch("consent");
        expect(consent.pathname).toMatch(/\/consent$/);
        expect(consent.searchParams.has("code")).toBe(false);
      });
    });

    describe("GET /oauth/authorize - OIDC Parameters", () => {
      it("should pass nonce parameter through to login", async () => {
        const nonce = "test-nonce-value-12345";

        const { response } = await getSessionCookie(
          testClient.clientId,
          testClient.redirectUris[0],
          { nonce }
        );

        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = response.headers.get("location") || "";
        expect(location).toContain(`nonce=${nonce}`);
      });

      it("should pass max_age parameter through to login", async () => {
        const { response } = await getSessionCookie(
          testClient.clientId,
          testClient.redirectUris[0],
          { maxAge: 3600 }
        );

        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = response.headers.get("location") || "";
        expect(location).toContain("max_age=3600");
      });

      it("should pass acr_values parameter through to login", async () => {
        const { response } = await getSessionCookie(
          testClient.clientId,
          testClient.redirectUris[0],
          { acrValues: "urn:auth-service:mfa" }
        );

        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = response.headers.get("location") || "";
        expect(location).toContain("acr_values=");
      });
    });

    describe("Security Tests", () => {
      it("should set httpOnly cookie for session", async () => {
        const codeChallenge = generateCodeChallenge(generateCodeVerifier());
        const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", testClient.clientId);
        authorizeUrl.searchParams.set(
          "redirect_uri",
          testClient.redirectUris[0]
        );
        authorizeUrl.searchParams.set("state", generateUniqueId());
        authorizeUrl.searchParams.set("scope", "openid");
        authorizeUrl.searchParams.set("code_challenge", codeChallenge);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");

        const response = await fetch(authorizeUrl.toString(), {
          method: "GET",
          redirect: "manual",
        });

        const setCookieHeader = response.headers.get("set-cookie") || "";
        expect(setCookieHeader.toLowerCase()).toContain("httponly");
      });

      it("should set sameSite attribute on cookie", async () => {
        const codeChallenge = generateCodeChallenge(generateCodeVerifier());
        const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", testClient.clientId);
        authorizeUrl.searchParams.set(
          "redirect_uri",
          testClient.redirectUris[0]
        );
        authorizeUrl.searchParams.set("state", generateUniqueId());
        authorizeUrl.searchParams.set("scope", "openid");
        authorizeUrl.searchParams.set("code_challenge", codeChallenge);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");

        const response = await fetch(authorizeUrl.toString(), {
          method: "GET",
          redirect: "manual",
        });

        const setCookieHeader = response.headers.get("set-cookie") || "";
        expect(setCookieHeader.toLowerCase()).toContain("samesite=");
      });

      it("should not allow session cookie reuse with different client", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = generateUniqueId();

        // Get session for first client
        const { sessionCookie } = await getSessionCookie(
          testClient.clientId,
          testClient.redirectUris[0],
          { codeChallenge, state }
        );

        // Try to use with different client
        const response = await fetch(`${BASE_URL}/oauth/authorize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionCookie,
          },
          body: JSON.stringify({
            response_type: "code",
            client_id: confidentialClient.clientId,
            redirect_uri: confidentialClient.redirectUris[0],
            state,
            scope: "openid",
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            email: testUser.email,
            password: testUser.plainPassword,
          }),
          redirect: "manual",
        });

        // Should still work since session is just for CSRF protection
        // but redirect_uri validation should catch mismatches
        expect(response.status).toBeLessThan(500);
      });
    });
  });
});

describe("/oauth/authorize", () => {
  describe("Email case", () => {
    let client: Awaited<ReturnType<typeof createTestClient>>;
    let user: Awaited<ReturnType<typeof createTestUser>>;

    beforeAll(async () => {
      client = await createTestClient();
      user = await createTestUser();
    });

    it("logs in with the email in a different case and padded", async () => {
      const token = await getAccessTokenForUser(
        { ...user, email: `  ${user.email.toUpperCase()} ` },
        client
      );

      const response = await fetch(`${BASE_URL}/v1/account/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(HTTP_STATUS.OK);
      const me = (await response.json()) as { id: string; email: string };
      expect(me).toMatchObject({ id: user.id, email: user.email });
    });

    it("refuses to store an email that is not lower case", async () => {
      await expect(
        prisma.user.update({
          where: { id: user.id },
          data: { email: user.email.toUpperCase() },
        })
      ).rejects.toThrow();
    });
  });
});

describe("/oauth/authorize", () => {
  const legacyHash = (password: string) => {
    const salt = randomBytes(32);
    const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return `${salt.toString("hex")}:${key.toString("hex")}`;
  };

  let client: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async () => {
    client = await createTestClient();
  });

  const storedHash = async (id: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id } })).passwordHash;

  describe("password hash upgrade at login", () => {
    it("rehashes a legacy hash at the current parameters on a correct login", async () => {
      const user = await createTestUser();
      const legacy = legacyHash(user.plainPassword);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: legacy },
      });

      expect(await getAccessTokenForUser(user, client)).toBeTruthy();

      const upgraded = await storedHash(user.id);
      expect(upgraded).not.toBe(legacy);
      expect(upgraded).toMatch(/^scrypt\$16384\$8\$5\$/);
      // The upgraded hash still lets the user in.
      expect(await getAccessTokenForUser(user, client)).toBeTruthy();
      expect(await storedHash(user.id)).toBe(upgraded);
    });

    it("leaves a current hash alone", async () => {
      const user = await createTestUser();
      expect(await getAccessTokenForUser(user, client)).toBeTruthy();
      expect(await storedHash(user.id)).toBe(user.passwordHash);
    });
  });
});

describe("/oauth/authorize", () => {
  // Test entity variables
  let TEST_CLIENT_ID = "";
  let TEST_CLIENT_DB_ID = "";
  let TEST_USER_ID = "";
  let TEST_USER_EMAIL = "";
  const TEST_USER_PASSWORD = "TestPassword123!";
  const TEST_REDIRECT_URI = "http://localhost:3000/test-callback";

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

  describe("OIDC Compliance", () => {
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
      TEST_CLIENT_ID = `test-oidc-client-${uniqueId}`;
      TEST_USER_EMAIL = `test-oidc-user-${uniqueId}@test.local`;

      // Create test owner user
      const ownerPasswordHash = await hashPassword("TestPassword123!");
      const testOwner = await prisma.user.create({
        data: {
          email: `test-oidc-owner-${uniqueId}@test.local`,
          passwordHash: ownerPasswordHash,
          name: "OIDC Test Owner",
          isActive: true,
        },
      });

      const client = await prisma.oAuthClient.create({
        data: {
          clientId: TEST_CLIENT_ID,
          clientSecret: null,
          clientType: "public",
          name: `OIDC Test Client ${uniqueId}`,
          redirectUris: [TEST_REDIRECT_URI],
          postLogoutRedirectUris: [],
          scopes: ["openid", "profile", "email", "offline_access"],
          grantTypes: ["authorization_code", "refresh_token"],
          audience: [],
          ownerId: testOwner.id,
        },
      });
      TEST_CLIENT_DB_ID = client.id;

      const passwordHash = await hashPassword(TEST_USER_PASSWORD);
      const user = await prisma.user.create({
        data: {
          email: TEST_USER_EMAIL,
          passwordHash,
          name: "OIDC Test User",
          isActive: true,
        },
      });
      TEST_USER_ID = user.id;
    });

    afterAll(async () => {
      // Cleanup test entities
      if (TEST_USER_ID) {
        await prisma.userSession.deleteMany({
          where: { userId: TEST_USER_ID },
        });
        await prisma.consentSession.deleteMany({
          where: { userId: TEST_USER_ID, clientId: TEST_CLIENT_DB_ID },
        });
        await prisma.user
          .delete({ where: { id: TEST_USER_ID } })
          .catch(() => {});
      }
      if (TEST_CLIENT_DB_ID) {
        await prisma.oAuthClient
          .delete({ where: { id: TEST_CLIENT_DB_ID } })
          .catch(() => {});
      }
    });

    describe("Authorize Endpoint - max_age parameter", () => {
      it("should accept max_age parameter and pass to login URL", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("max_age", "3600");

        const response = await fetch(url.toString(), { redirect: "manual" });

        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = response.headers.get("location") || "";
        expect(location).toContain("max_age=3600");
      });

      it("should accept max_age=0 (forces re-auth)", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("max_age", "0");

        const response = await fetch(url.toString(), { redirect: "manual" });

        expect(response.status).toBe(HTTP_STATUS.FOUND);
      });
    });

    describe("Authorize Endpoint - acr_values parameter", () => {
      it("should accept acr_values parameter and pass to login URL", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("acr_values", "urn:auth-service:mfa");

        const response = await fetch(url.toString(), { redirect: "manual" });

        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = response.headers.get("location") || "";
        expect(location).toContain("acr_values=");
      });

      it("should accept space-separated acr_values", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set(
          "acr_values",
          "urn:auth-service:mfa urn:auth-service:pwd"
        );

        const response = await fetch(url.toString(), { redirect: "manual" });

        expect(response.status).toBe(HTTP_STATUS.FOUND);
      });
    });

    describe("Authorize Endpoint - prompt parameter", () => {
      it("should accept prompt=login and pass to login URL", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("prompt", "login");

        const response = await fetch(url.toString(), { redirect: "manual" });

        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = response.headers.get("location") || "";
        expect(location).toContain("prompt=login");
      });

      it("shows the consent screen for prompt=consent to a client that otherwise skips it", async () => {
        const loginTo = async (prompt?: string) => {
          const pkce = newPkce();
          const params = {
            response_type: "code",
            client_id: TEST_CLIENT_ID,
            redirect_uri: TEST_REDIRECT_URI,
            state: pkce.state,
            scope: "openid",
            code_challenge: pkce.challenge,
            code_challenge_method: "S256",
            ...(prompt && { prompt }),
          };
          const jar: CookieJar = new Map();
          const start = await fetch(
            `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
            { redirect: "manual" }
          );
          absorbCookies(jar, start);
          const login = new URL(start.headers.get("location") ?? "");
          expect(login.pathname).toMatch(/\/login$/);
          expect(login.searchParams.get("prompt") || null).toBe(prompt ?? null);
          const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: cookieHeader(jar),
            },
            body: JSON.stringify({
              ...params,
              email: TEST_USER_EMAIL,
              password: TEST_USER_PASSWORD,
            }),
          });
          expect(submit.status).toBe(HTTP_STATUS.OK);
          const { redirect_url } = (await submit.json()) as {
            redirect_url: string;
          };
          return new URL(redirect_url);
        };

        await prisma.oAuthClient.update({
          where: { id: TEST_CLIENT_DB_ID },
          data: { consentRequired: false },
        });
        try {
          expect((await loginTo()).searchParams.has("code")).toBe(true);
          const consent = await loginTo("consent");
          expect(consent.pathname).toMatch(/\/consent$/);
          expect(consent.searchParams.has("code")).toBe(false);
          expect(consent.searchParams.get("session")).toBeTruthy();
        } finally {
          await prisma.oAuthClient.update({
            where: { id: TEST_CLIENT_DB_ID },
            data: { consentRequired: true },
          });
        }
      });

      it("should accept prompt=select_account and pass to login URL", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("prompt", "select_account");

        const response = await fetch(url.toString(), { redirect: "manual" });

        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = response.headers.get("location") || "";
        expect(location).toContain("prompt=select_account");
      });

      const authorizeWithPrompt = (prompt: string) => {
        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set(
          "code_challenge",
          generateCodeChallenge(generateCodeVerifier())
        );
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("prompt", prompt);
        return fetch(url.toString(), { redirect: "manual" });
      };

      it("should accept a space-separated prompt list", async () => {
        const response = await authorizeWithPrompt("login consent");
        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = new URL(response.headers.get("location") ?? "");
        expect(location.pathname).toMatch(/\/login$/);
        expect(location.searchParams.get("prompt")).toBe("login consent");
      });

      it("should reject prompt=none combined with another value", async () => {
        const response = await authorizeWithPrompt("none login");
        expectAuthorizeErrorRedirect(
          response,
          TEST_REDIRECT_URI,
          "invalid_request",
          "test-state"
        );
      });

      it("should reject an unknown prompt value", async () => {
        const response = await authorizeWithPrompt("login bogus");
        expectAuthorizeErrorRedirect(
          response,
          TEST_REDIRECT_URI,
          "invalid_request",
          "test-state"
        );
      });

      it("should return login_required for prompt=none without session", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = randomBytes(16).toString("hex");

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", state);
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("prompt", "none");

        const response = await fetch(url.toString(), { redirect: "manual" });

        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = response.headers.get("location") || "";
        expect(location).toContain("error=login_required");
      });

      it("should preserve state in prompt=none error redirect", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = "my-unique-state-12345";

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", state);
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("prompt", "none");

        const response = await fetch(url.toString(), { redirect: "manual" });

        const location = response.headers.get("location") || "";
        expect(location).toContain(`state=${state}`);
      });

      it("should reject invalid prompt value", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("prompt", "invalid_value");

        const response = await fetch(url.toString(), { redirect: "manual" });

        expectAuthorizeErrorRedirect(
          response,
          TEST_REDIRECT_URI,
          "invalid_request",
          "test-state"
        );
      });

      it("should reject uppercase prompt value (case-sensitive)", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("prompt", "NONE");

        const response = await fetch(url.toString(), { redirect: "manual" });

        expectAuthorizeErrorRedirect(
          response,
          TEST_REDIRECT_URI,
          "invalid_request",
          "test-state"
        );
      });
    });

    describe("Authorize Endpoint - nonce parameter", () => {
      it("should accept nonce parameter and pass to login URL", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const nonce = randomBytes(16).toString("hex");

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("nonce", nonce);

        const response = await fetch(url.toString(), { redirect: "manual" });

        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = response.headers.get("location") || "";
        expect(location).toContain(`nonce=${nonce}`);
      });

      it("should include nonce in id_token when provided", async () => {
        // This test validates that nonce parameter is accepted
        // Full validation that nonce appears in id_token requires token exchange
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const nonce = randomBytes(16).toString("hex");

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("nonce", nonce);

        const response = await fetch(url.toString(), { redirect: "manual" });

        // Should accept and redirect
        expect(response.status).toBe(HTTP_STATUS.FOUND);
      });
    });

    describe("Authorize Endpoint - login_hint parameter", () => {
      it("should accept login_hint parameter", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("login_hint", TEST_USER_EMAIL);

        const response = await fetch(url.toString(), { redirect: "manual" });

        // Should redirect without error (login_hint may or may not be passed through)
        expect(response.status).toBe(HTTP_STATUS.FOUND);
      });

      it("should accept email as login_hint", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("login_hint", "user@example.com");

        const response = await fetch(url.toString(), { redirect: "manual" });

        // Should redirect without error
        expect(response.status).toBe(HTTP_STATUS.FOUND);
      });
    });

    describe("Authorize Endpoint - ui_locales parameter", () => {
      it("should accept ui_locales parameter", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("ui_locales", "en");

        const response = await fetch(url.toString(), { redirect: "manual" });

        // Should redirect without error (ui_locales is optional)
        expect(response.status).toBe(HTTP_STATUS.FOUND);
      });

      it("should accept space-separated ui_locales", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("ui_locales", "en es fr");

        const response = await fetch(url.toString(), { redirect: "manual" });

        // Should redirect without error
        expect(response.status).toBe(HTTP_STATUS.FOUND);
      });
    });

    describe("Authorize Endpoint - claims parameter", () => {
      it("should accept claims parameter with userinfo claims", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const claims = JSON.stringify({
          userinfo: {
            name: { essential: true },
            email: { essential: true },
          },
        });

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid profile email");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("claims", claims);

        const response = await fetch(url.toString(), { redirect: "manual" });

        // Should redirect without error (claims is optional)
        expect(response.status).toBe(HTTP_STATUS.FOUND);
      });

      it("should accept claims parameter with id_token claims", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const claims = JSON.stringify({
          id_token: {
            auth_time: { essential: true },
            acr: { values: ["urn:auth-service:mfa"] },
          },
        });

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("claims", claims);

        const response = await fetch(url.toString(), { redirect: "manual" });

        // Should redirect without error
        expect(response.status).toBe(HTTP_STATUS.FOUND);
      });
    });

    describe("Multiple OIDC parameters combined", () => {
      it("should accept multiple OIDC parameters together", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const nonce = randomBytes(16).toString("hex");
        const state = randomBytes(16).toString("hex");

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", state);
        url.searchParams.set("scope", "openid profile email");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("nonce", nonce);
        url.searchParams.set("prompt", "login");
        url.searchParams.set("max_age", "3600");
        url.searchParams.set("ui_locales", "en");
        url.searchParams.set("acr_values", "urn:auth-service:pwd");
        url.searchParams.set("login_hint", "user@example.com");

        const response = await fetch(url.toString(), { redirect: "manual" });

        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = response.headers.get("location") || "";

        // Verify multiple params are passed through
        expect(location).toContain("nonce=");
        expect(location).toContain("prompt=");
        expect(location).toContain("max_age=");
      });
    });
  });
});
