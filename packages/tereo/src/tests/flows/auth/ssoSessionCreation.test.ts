// @module-tag int
// @module-tag auth
import { hashFlowToken, hashPassword } from "../../../utils/crypto.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BASE_URL, HTTP_STATUS } from "../../support/auth.js";
import { prisma } from "../../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import {
  browserLogin,
  confirmLogout,
  newPkce,
  userSessionCookieName,
  type CookieJar,
} from "../../support/browserLogin.js";

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

  describe("Session-based authentication flows", () => {
    const signIn = () =>
      browserLogin({
        clientId: TEST_CLIENT_ID,
        redirectUri: TEST_REDIRECT_URI,
        scope: "openid profile",
        email: TEST_USER_EMAIL,
        password: TEST_USER_PASSWORD,
      });

    /** The SSO cookie's `name=value`, asserting the login left one. */
    const ssoCookie = (jar: CookieJar) => {
      const name = userSessionCookieName(TEST_CLIENT_ID);
      const value = jar.get(name);
      expect(value, `${name} cookie`).toBeTruthy();
      return `${name}=${value}`;
    };

    const promptNone = (cookie: string) => {
      const pkce = newPkce();
      const url = new URL(`${BASE_URL}/oauth/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", TEST_CLIENT_ID);
      url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
      url.searchParams.set("state", pkce.state);
      url.searchParams.set("scope", "openid");
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("prompt", "none");
      return fetch(url.toString(), {
        redirect: "manual",
        headers: { Cookie: cookie },
      });
    };

    it("should create user session after successful authentication", async () => {
      const { jar } = await signIn();
      const cookie = ssoCookie(jar);

      const token = cookie.slice(cookie.indexOf("=") + 1);
      const session = await prisma.userSession.findUnique({
        where: { tokenHash: hashFlowToken(token) },
      });
      expect(session?.userId).toBe(TEST_USER_ID);
    });

    it("should accept a valid user session under prompt=none, answering consent_required for a third-party client", async () => {
      const { jar } = await signIn();

      const response = await promptNone(ssoCookie(jar));

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.searchParams.get("error")).toBe("consent_required");
      expect(location.searchParams.get("code")).toBeNull();
    });

    it("should invalidate session after a confirmed end-session", async () => {
      const { jar } = await signIn();
      const cookie = ssoCookie(jar);

      const endSessionResponse = await fetch(`${BASE_URL}/oauth/end-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ client_id: TEST_CLIENT_ID }),
        redirect: "manual",
      });
      const confirmed = await confirmLogout(jar, endSessionResponse);
      expect(confirmed.status).toBe(HTTP_STATUS.OK);
      expect(jar.has(userSessionCookieName(TEST_CLIENT_ID))).toBe(false);

      // The old cookie value, replayed, must no longer resolve to a session.
      const response = await promptNone(cookie);
      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.searchParams.get("error")).toBe("login_required");
    });
  });
});
