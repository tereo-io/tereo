// @module-tag int
// @module-tag auth
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hashPassword } from "../../../utils/crypto.js";
import { prisma } from "../../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import {
  absorbCookies,
  browserLogin,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../../support/browserLogin.js";
import {
  BASE_URL,
  HTTP_STATUS,
  fetchDiscoveryDocument,
} from "../../support/auth.js";

// Test entity variables
let TEST_CLIENT_ID = "";
let TEST_CLIENT_DB_ID = "";
let TEST_USER_ID = "";
let TEST_USER_EMAIL = "";
const TEST_USER_PASSWORD = "TestPassword123!";
const TEST_REDIRECT_URI = "http://localhost:3000/test-callback";
const TEST_POST_LOGOUT_URI = "http://localhost:3000/test-logout";

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
        postLogoutRedirectUris: [TEST_POST_LOGOUT_URI],
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
      await prisma.userSession.deleteMany({ where: { userId: TEST_USER_ID } });
      await prisma.consentSession.deleteMany({
        where: { userId: TEST_USER_ID, clientId: TEST_CLIENT_DB_ID },
      });
      await prisma.user.delete({ where: { id: TEST_USER_ID } }).catch(() => {});
    }
    if (TEST_CLIENT_DB_ID) {
      await prisma.oAuthClient
        .delete({ where: { id: TEST_CLIENT_DB_ID } })
        .catch(() => {});
    }
  });

  describe("Authorization response issuer (RFC 9207)", () => {
    const issuer = async () => (await fetchDiscoveryDocument()).issuer;

    const authorizeParams = () => {
      const pkce = newPkce();
      return {
        response_type: "code",
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        state: pkce.state,
        scope: "openid",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      };
    };

    it("advertises iss in both discovery documents", async () => {
      for (const path of [
        "/.well-known/openid-configuration",
        "/.well-known/oauth-authorization-server",
      ]) {
        const doc = (await (await fetch(`${BASE_URL}${path}`)).json()) as {
          authorization_response_iss_parameter_supported?: boolean;
        };
        expect(doc.authorization_response_iss_parameter_supported, path).toBe(
          true
        );
      }
    });

    it("adds iss to the code redirect", async () => {
      const { redirectUrl } = await browserLogin({
        clientId: TEST_CLIENT_ID,
        redirectUri: TEST_REDIRECT_URI,
        scope: "openid",
        email: TEST_USER_EMAIL,
        password: TEST_USER_PASSWORD,
      });
      const url = new URL(redirectUrl);
      expect(url.searchParams.get("code")).toBeTruthy();
      expect(url.searchParams.get("iss")).toBe(await issuer());
    });

    it("adds iss to an error redirect from /oauth/authorize", async () => {
      const params = { ...authorizeParams(), prompt: "none" };
      const res = await fetch(
        `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
        { redirect: "manual" }
      );
      const url = new URL(res.headers.get("location") ?? "");
      expect(url.searchParams.get("error")).toBe("login_required");
      expect(url.searchParams.get("state")).toBe(params.state);
      expect(url.searchParams.get("iss")).toBe(await issuer());
    });

    it("adds iss to a denied consent's redirect", async () => {
      const jar: CookieJar = new Map();
      const params = authorizeParams();
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
          email: TEST_USER_EMAIL,
          password: TEST_USER_PASSWORD,
        }),
      });
      absorbCookies(jar, submit);
      const { redirect_url } = (await submit.json()) as {
        redirect_url: string;
      };
      const denied = await fetch(`${BASE_URL}/oauth/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader(jar),
        },
        body: JSON.stringify({
          session_token: new URL(redirect_url).searchParams.get("session"),
          approved: false,
        }),
      });
      expect(denied.status).toBe(HTTP_STATUS.OK);
      const url = new URL(
        ((await denied.json()) as { redirect_url: string }).redirect_url
      );
      expect(url.searchParams.get("error")).toBe("access_denied");
      expect(url.searchParams.get("iss")).toBe(await issuer());
    });
  });
});
