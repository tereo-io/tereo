// @module-tag int
// @module-tag auth
import { browserLogin, type CookieJar } from "../../../support/browserLogin.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import { createHash } from "node:crypto";
import {
  LOGIN_CLIENT,
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../../../definitions/index.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../support/webhooks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
  TokenResponse,
  decodeJwt,
} from "../../../support/auth.js";

describe("POST /oauth/token", () => {
  describe("OAuth Token Endpoint", () => {
    let testClient: Awaited<ReturnType<typeof createTestClient>>;
    let testUser: Awaited<ReturnType<typeof createTestUser>>;

    beforeAll(async () => {
      testClient = await createTestClient();
      testUser = await createTestUser();
    });

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

    // Helper to get authorization code
    async function getAuthorizationCode(
      client: typeof testClient,
      user: typeof testUser,
      codeChallenge: string,
      scope: string = "openid profile email"
    ): Promise<string | null> {
      const state = generateUniqueId();
      const redirectUri = client.redirectUris[0];

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

      expect(sessionCookie).toBeTruthy();

      // Step 2: POST credentials with the session cookie
      const response = await fetch(`${BASE_URL}/oauth/authorize`, {
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

      const authData = (await response.json()) as AuthorizeResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(authData.redirect_url).toContain("/consent");
      const consentUrl = new URL(authData.redirect_url!);
      const sessionId = consentUrl.searchParams.get("session");

      expect(sessionId).toBeTruthy();
      // Extract consent cookie from auth response
      // Cookie name is tereo_consent_session_{clientId}
      const authCookieHeader = response.headers.get("set-cookie") || "";
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
        body: JSON.stringify({ session_token: sessionId, approved: true }),
        redirect: "manual",
      });

      const consentData = (await consentResponse.json()) as ConsentResponse;
      expect(consentData.redirect_url).toContain("code=");
      const code = new URL(consentData.redirect_url!).searchParams.get("code");
      expect(code).toBeTruthy();
      return code;
    }

    describe("POST /oauth/token - Authorization Code Grant", () => {
      it("should exchange authorization code for tokens with 200 status", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const code = await getAuthorizationCode(
          testClient,
          testUser,
          codeChallenge
        );

        expect(code).not.toBeNull();

        const response = await fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            redirect_uri: testClient.redirectUris[0],
            client_id: testClient.clientId,
            code_verifier: codeVerifier,
          }),
        });

        const data = (await response.json()) as TokenResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.access_token).toBeDefined();
        expect(typeof data.access_token).toBe("string");
        expect(data.access_token?.length).toBeGreaterThan(0);
        expect(data.token_type).toBe("Bearer");
        expect(data.expires_in).toBeDefined();
        expect(typeof data.expires_in).toBe("number");
        expect(data.expires_in).toBeGreaterThan(0);
        expect(data.error).toBeUndefined();
      });

      it("should return id_token when openid scope is requested", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const code = await getAuthorizationCode(
          testClient,
          testUser,
          codeChallenge
        );

        const response = await fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            redirect_uri: testClient.redirectUris[0],
            client_id: testClient.clientId,
            code_verifier: codeVerifier,
          }),
        });

        const data = (await response.json()) as TokenResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.id_token).toBeDefined();
        expect(typeof data.id_token).toBe("string");
        // ID token should be a JWT with 3 parts separated by dots
        expect(data.id_token!.split(".").length).toBe(3);
      });

      it("should return a refresh_token to a client with the refresh_token grant, offline_access or not", async () => {
        expect(testClient.grantTypes).toContain("refresh_token");
        const exchange = async (client: typeof testClient, scope: string) => {
          const codeVerifier = generateCodeVerifier();
          const code = await getAuthorizationCode(
            client,
            testUser,
            generateCodeChallenge(codeVerifier),
            scope
          );
          expect(code).not.toBeNull();
          const response = await fetch(`${BASE_URL}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              grant_type: "authorization_code",
              code,
              redirect_uri: client.redirectUris[0],
              client_id: client.clientId,
              code_verifier: codeVerifier,
            }),
          });
          expect(response.status).toBe(HTTP_STATUS.OK);
          return (await response.json()) as TokenResponse;
        };

        for (const scope of ["openid", "openid offline_access"]) {
          const data = await exchange(testClient, scope);
          expect(typeof data.refresh_token).toBe("string");
          expect(data.refresh_token!.length).toBeGreaterThan(0);
        }

        // The grant type decides, not the scope.
        const codeOnly = await createTestClient({
          grantTypes: ["authorization_code"],
        });
        const data = await exchange(codeOnly, "openid offline_access");
        expect(data.refresh_token).toBeUndefined();
      });
    });

    describe("POST /oauth/token - Refresh Token Grant", () => {
      it("should refresh access token using refresh_token with 200 status", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        // Get initial tokens with offline_access
        const code = await getAuthorizationCode(
          testClient,
          testUser,
          codeChallenge,
          "openid offline_access"
        );

        expect(code).not.toBeNull();

        const tokenResponse = await fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            redirect_uri: testClient.redirectUris[0],
            client_id: testClient.clientId,
            code_verifier: codeVerifier,
          }),
        });

        const tokens = (await tokenResponse.json()) as TokenResponse;
        expect(tokens.refresh_token).toBeDefined();

        // Now use refresh token
        const refreshResponse = await fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
            client_id: testClient.clientId,
          }),
        });

        const newTokens = (await refreshResponse.json()) as TokenResponse;

        expect(refreshResponse.status).toBe(HTTP_STATUS.OK);
        expect(newTokens.access_token).toBeDefined();
        expect(typeof newTokens.access_token).toBe("string");
        expect(newTokens.access_token).not.toBe(tokens.access_token);
        expect(newTokens.token_type).toBe("Bearer");
        expect(newTokens.expires_in).toBeDefined();
        expect(newTokens.error).toBeUndefined();

        // Both tokens are stored only as their SHA-256, the lookup key.
        for (const token of [tokens.refresh_token!, newTokens.refresh_token!]) {
          const tokenHash = createHash("sha256").update(token).digest("hex");
          const row = await prisma.refreshToken.findUnique({
            where: { tokenHash },
          });
          expect(row).not.toBeNull();
        }
      });
    });

    describe("POST /oauth/token - Client Credentials Grant", () => {
      let clientCredentialsClient: Awaited<ReturnType<typeof createTestClient>>;

      beforeAll(async () => {
        // Create a confidential client with client_credentials grant type
        clientCredentialsClient = await createTestClient({
          clientType: "confidential",
          grantTypes: ["client_credentials"],
          scopes: ["openid", "profile"],
        });
      });

      it("should issue access token with client_credentials grant with 200 status (Basic Auth)", async () => {
        // Server requires Basic Auth for confidential clients
        const credentials = Buffer.from(
          `${clientCredentialsClient.clientId}:${clientCredentialsClient.plainSecret}`
        ).toString("base64");

        const response = await fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${credentials}`,
          },
          body: JSON.stringify({
            grant_type: "client_credentials",
            scope: "openid",
          }),
        });

        const data = (await response.json()) as TokenResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.access_token).toBeDefined();
        expect(typeof data.access_token).toBe("string");
        expect(data.token_type).toBe("Bearer");
        expect(data.expires_in).toBeDefined();
        expect(data.error).toBeUndefined();
        // client_credentials should NOT return refresh_token
        expect(data.refresh_token).toBeUndefined();
      });

      it("introspection reports the client as sub, as the token does", async () => {
        const credentials = Buffer.from(
          `${clientCredentialsClient.clientId}:${clientCredentialsClient.plainSecret}`
        ).toString("base64");
        const tokenRes = await fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${credentials}`,
          },
          body: JSON.stringify({ grant_type: "client_credentials" }),
        });
        const { access_token } = (await tokenRes.json()) as TokenResponse;

        const res = await fetch(`${BASE_URL}/oauth/introspect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${credentials}`,
          },
          body: JSON.stringify({ token: access_token }),
        });
        const data = (await res.json()) as { active: boolean; sub?: string };

        expect(data.active).toBe(true);
        expect(data.sub).toBe(clientCredentialsClient.clientId);
      });

      it("should support Basic Auth for client_credentials grant with 200 status", async () => {
        const credentials = Buffer.from(
          `${clientCredentialsClient.clientId}:${clientCredentialsClient.plainSecret}`
        ).toString("base64");

        const response = await fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${credentials}`,
          },
          body: JSON.stringify({
            grant_type: "client_credentials",
            scope: "openid",
          }),
        });

        const data = (await response.json()) as TokenResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.access_token).toBeDefined();
        expect(data.token_type).toBe("Bearer");
        expect(data.error).toBeUndefined();
      });

      it("issues a token to a client holding no scopes, when none is asked for, and refuses openid", async () => {
        // As a provisioned service or integration client: scopes [].
        const scopeless = await createTestClient({
          clientType: "confidential",
          grantTypes: ["client_credentials"],
          scopes: [],
        });
        const credentials = Buffer.from(
          `${scopeless.clientId}:${scopeless.plainSecret}`
        ).toString("base64");
        const token = (body: Record<string, string>) =>
          fetch(`${BASE_URL}/oauth/token`, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization: `Basic ${credentials}`,
            },
            body: new URLSearchParams(body),
          });

        const issued = await token({ grant_type: "client_credentials" });
        expect(issued.status).toBe(HTTP_STATUS.OK);
        expect(((await issued.json()) as TokenResponse).access_token).toEqual(
          expect.any(String)
        );

        const refused = await token({
          grant_type: "client_credentials",
          scope: "openid",
        });
        expect(refused.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(((await refused.json()) as TokenResponse).error).toBe(
          "invalid_scope"
        );
      });
    });
  });
});

describe("POST /oauth/token", () => {
  type Client = Awaited<ReturnType<typeof createTestClient>>;

  const basic = (client: Client) =>
    `Basic ${Buffer.from(`${client.clientId}:${client.plainSecret}`).toString("base64")}`;

  const form = (body: Record<string, string>) =>
    new URLSearchParams(body).toString();

  const postForm = (
    path: string,
    body: Record<string, string>,
    headers: Record<string, string> = {}
  ) =>
    fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: form(body),
    });
  let ccClient: Client;

  beforeAll(async () => {
    ccClient = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
    });
  });

  describe("Client authentication", () => {
    it("marks token responses uncacheable", async () => {
      const res = await postForm(
        "/oauth/token",
        { grant_type: "client_credentials" },
        { Authorization: basic(ccClient) }
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("pragma")).toBe("no-cache");
    });
  });
});

describe("POST /oauth/token", () => {
  type Client = { clientId: string; redirectUris: string[] };

  const exchange = async (client: Client) => {
    const user = await createTestUser();
    const redirectUri = client.redirectUris[0];
    const { code, verifier } = await browserLogin({
      clientId: client.clientId,
      redirectUri,
      scope: "openid offline_access",
      email: user.email,
      password: user.plainPassword,
    });
    const res = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.clientId,
        code_verifier: verifier,
      }),
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
    return (await res.json()) as {
      access_token: string;
      refresh_token?: string;
    };
  };

  describe("refresh tokens at the code exchange", () => {
    it("are issued to a client with the refresh_token grant", async () => {
      const client = await createTestClient({
        grantTypes: ["authorization_code", "refresh_token"],
      });
      expect((await exchange(client)).refresh_token).toBeTruthy();
    });

    it("are not issued to a client without it", async () => {
      const client = await createTestClient({
        grantTypes: ["authorization_code"],
      });
      const tokens = await exchange(client);
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.refresh_token).toBeUndefined();
    });

    it("are issued to core's UI", async () => {
      const ui = await prisma.oAuthClient.findUniqueOrThrow({
        where: { clientId: LOGIN_CLIENT.clientId },
      });
      expect(ui.grantTypes).toContain("refresh_token");
      expect((await exchange(ui)).refresh_token).toBeTruthy();
    });
  });
});

describe("POST /oauth/token", () => {
  const REDIRECT_URI = "http://localhost:3000/token-lifecycle-audit-callback";
  const SCOPE = "openid offline_access";

  type TestUser = Awaited<ReturnType<typeof createTestUser>>;

  let client: Awaited<ReturnType<typeof createTestClient>>;
  let endpointId: string;

  beforeAll(async () => {
    client = await createTestClient({ redirectUris: [REDIRECT_URI] });
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.user.sessions-revoked"] }
    );
    endpointId = endpoint.id;
  });

  const exchange = (code: string, verifier: string) =>
    fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });

  const refresh = (refreshToken: string) =>
    fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: refreshToken,
      }),
    });

  interface Tokens {
    access_token: string;
    refresh_token: string;
    id_token: string;
  }

  const signIn = async (user?: TestUser, jar?: CookieJar) => {
    const u = user ?? (await createTestUser());
    const login = await browserLogin({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      email: u.email,
      password: u.plainPassword,
      jar,
    });
    const res = await exchange(login.code, login.verifier);
    expect(res.status).toBe(HTTP_STATUS.OK);
    return {
      user: u,
      jar: login.jar,
      code: login.code,
      verifier: login.verifier,
      tokens: (await res.json()) as Tokens,
    };
  };

  const sidOf = (accessToken: string) =>
    (decodeJwt(accessToken) as unknown as { sid: string }).sid;

  const entriesOf = (userId: string) =>
    prisma.auditLogEntry.findMany({
      where: { entityType: "User", entityId: userId },
      orderBy: { createdAt: "asc" },
    });

  const revokedEventsFor = (userId: string) =>
    prisma.webhookDelivery.count({
      where: {
        webhookEndpointId: endpointId,
        eventType: "auth.user.sessions-revoked",
        payload: { path: ["entityId"], equals: userId },
      },
    });

  const expectRevokedEvent = (userId: string) =>
    waitFor(async () => (await revokedEventsFor(userId)) > 0, 10_000);

  describe("token reuse", () => {
    it("audits a replayed authorization code as core and emits the revocation", async () => {
      const { user, code, verifier, tokens } = await signIn();

      const replay = await exchange(code, verifier);
      expect(replay.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(((await replay.json()) as { error: string }).error).toBe(
        "invalid_grant"
      );

      const authCode = await prisma.authorizationCode.findFirstOrThrow({
        where: { userId: user.id, clientId: client.id },
      });
      const entry = (await entriesOf(user.id)).find(
        (e) =>
          (e.metadata as { action?: string } | null)?.action ===
          "token_reuse_detected"
      );
      expect(entry).toMatchObject({
        action: "UPDATE",
        userId: SYSTEM_USER_ID,
        writerUserId: SYSTEM_USER_ID,
        entityName: user.email,
      });
      expect(entry?.metadata).toEqual({
        action: "token_reuse_detected",
        credential: "authorization_code",
        clientId: client.clientId,
        authCodeId: authCode.id,
        sessionIds: [sidOf(tokens.access_token)],
        revokedAccessTokens: 1,
        revokedRefreshTokens: 1,
      });
      await expectRevokedEvent(user.id);
    });

    it("audits a replayed refresh token past the grace", async () => {
      const { user, tokens } = await signIn();
      const rotated = await refresh(tokens.refresh_token);
      expect(rotated.status).toBe(HTTP_STATUS.OK);
      const successor = (await rotated.json()) as Tokens;
      // Out of the race window: a replay now is theft, not a second tab.
      await prisma.refreshToken.update({
        where: { id: sidOf(tokens.access_token) },
        data: { rotatedAt: new Date(Date.now() - 60_000) },
      });

      expect((await refresh(tokens.refresh_token)).status).toBe(
        HTTP_STATUS.BAD_REQUEST
      );

      const entry = (await entriesOf(user.id)).find(
        (e) =>
          (e.metadata as { action?: string } | null)?.action ===
          "token_reuse_detected"
      );
      expect(entry).toMatchObject({ action: "UPDATE", userId: SYSTEM_USER_ID });
      expect(entry?.metadata).toMatchObject({
        credential: "refresh_token",
        clientId: client.clientId,
        sessionIds: [sidOf(successor.access_token)],
        revokedRefreshTokens: 1,
      });
      await expectRevokedEvent(user.id);
    });
  });
});
