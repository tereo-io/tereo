// @module-tag int
// @module-tag auth
// @module-tag security
import { BASE_URL, HTTP_STATUS } from "../support/auth/constants.js";
import { getTestPrincipalToken } from "../support/principals.js";
import { createTestClient } from "../support/auth/clients.js";
import { LOGIN_CLIENT } from "../../definitions/index.js";
import { browserLogin } from "../support/browserLogin.js";
import { createTestUser } from "../support/auth/users.js";
import { describe, it, expect, beforeAll } from "vitest";
import { getJwtHeader } from "../support/auth/tokens.js";
import { generateIdToken } from "../../utils/tokens.js";
import { currentSigningKey } from "../../utils/keys.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "node:crypto";
import env from "../../env.js";
import jwt from "jsonwebtoken";
import {
  getAccessTokenForUser,
  json,
  postForm,
} from "../support/auth/login.js";

describe("requireAuth", () => {
  describe("access token typ", () => {
    /**
     * Access tokens carry `typ: at+jwt` (RFC 9068). One without it is from
     * before the change and is accepted only if issued before the server
     * started; an ID token is never accepted.
     */

    const me = (token: string) =>
      fetch(`${BASE_URL}/v1/account/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });

    /** A stored access token for the UI's client, signed with the given header. */
    const legacyToken = async (iat: number, typ?: string) => {
      const user = await createTestUser();
      const client = await prisma.oAuthClient.findUniqueOrThrow({
        where: { clientId: LOGIN_CLIENT.clientId },
      });
      const jti = randomUUID();
      const exp = Math.floor(Date.now() / 1000) + 3600;
      await prisma.accessToken.create({
        data: {
          jti,
          clientId: client.id,
          userId: user.id,
          scopes: [],
          expiresAt: new Date(exp * 1000),
        },
      });
      return jwt.sign(
        {
          iss: env.ISSUER,
          sub: user.id,
          iat,
          exp,
          jti,
          scope: "",
          client_id: client.clientId,
        },
        currentSigningKey().privateKey,
        {
          algorithm: "RS256",
          keyid: currentSigningKey().kid,
          ...(typ !== undefined && { header: { alg: "RS256", typ } }),
        }
      );
    };

    const now = () => Math.floor(Date.now() / 1000);

    it("is at+jwt on issued access tokens", async () => {
      const token = await getTestPrincipalToken({ permissions: [] });
      expect(getJwtHeader(token).typ).toBe("at+jwt");
      expect((await me(token)).status).toBe(HTTP_STATUS.OK);
    });

    it("accepts a JWT-typed token issued before the server started", async () => {
      const token = await legacyToken(now() - 3 * 3600);
      expect(getJwtHeader(token).typ).toBe("JWT");
      expect((await me(token)).status).toBe(HTTP_STATUS.OK);
    });

    it("refuses a JWT-typed token issued since", async () => {
      const token = await legacyToken(now() + 3600);
      expect((await me(token)).status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("refuses any other typ", async () => {
      const token = await legacyToken(now() - 3 * 3600, "id+jwt");
      expect((await me(token)).status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("refuses an ID token, which is typed JWT", async () => {
      const user = await createTestUser();
      const { token } = generateIdToken({
        subject: user.id,
        clientId: LOGIN_CLIENT.clientId,
      });
      expect(getJwtHeader(token).typ).toBe("JWT");
      expect((await me(token)).status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });
  });

  describe("bearer scheme case", () => {
    let token: string;

    beforeAll(async () => {
      token = await getTestPrincipalToken({
        permissions: ["webhooks.event-types.read"],
      });
    });

    it("admits a valid token sent as bearer or BEARER", async () => {
      for (const scheme of ["Bearer", "bearer", "BEARER"]) {
        const res = await fetch(`${BASE_URL}/v1/webhooks/event-types`, {
          headers: { Authorization: `${scheme} ${token}` },
        });
        expect(res.status, scheme).toBe(HTTP_STATUS.OK);
      }
    });

    it("still refuses another scheme", async () => {
      const res = await fetch(`${BASE_URL}/v1/webhooks/event-types`, {
        headers: { Authorization: `Token ${token}` },
      });
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("admits a lower-case bearer at /oauth/userinfo", async () => {
      const user = await createTestUser();
      const client = await createTestClient();
      const userToken = await getAccessTokenForUser(user, client);
      const res = await fetch(`${BASE_URL}/oauth/userinfo`, {
        headers: { Authorization: `bearer ${userToken}` },
      });
      expect(res.status).toBe(HTTP_STATUS.OK);
    });
  });

  describe("an ID token presented as an access token", () => {
    /**
     * ID tokens are signed with the access tokens' key and issuer, but carry no
     * jti, client_id or scope. None of the endpoints that verify an access token
     * may take one for an access token.
     */

    let client: Awaited<ReturnType<typeof createTestClient>>;

    beforeAll(async () => {
      client = await createTestClient();
    });

    const idTokenFor = (userId: string) =>
      generateIdToken({ subject: userId, clientId: client.clientId }).token;

    it("revoking it at /oauth/revoke leaves other users' access tokens alone", async () => {
      const victim = await createTestUser();
      const victimToken = await getAccessTokenForUser(victim, client);
      const holder = await createTestUser();

      const revoke = await fetch(`${BASE_URL}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: client.clientId,
          token: idTokenFor(holder.id),
        }),
      });
      expect(revoke.status).toBe(HTTP_STATUS.OK);

      const me = await fetch(`${BASE_URL}/v1/account/me`, {
        headers: { Authorization: `Bearer ${victimToken}` },
      });
      expect(me.status).toBe(HTTP_STATUS.OK);
    });

    it("is inactive at /oauth/userinfo", async () => {
      const user = await createTestUser();
      const res = await fetch(`${BASE_URL}/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${idTokenFor(user.id)}` },
      });
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });
  });

  describe("Token types", () => {
    const SCOPE = "openid profile email offline_access";
    const REDIRECT_URI = "http://localhost:3000/callback";

    type Client = Awaited<ReturnType<typeof createTestClient>>;

    const basic = (client: Client) =>
      `Basic ${Buffer.from(`${client.clientId}:${client.plainSecret}`).toString("base64")}`;

    let publicClient: Client;
    let ccClient: Client;
    let user: Awaited<ReturnType<typeof createTestUser>>;

    beforeAll(async () => {
      publicClient = await createTestClient({ redirectUris: [REDIRECT_URI] });
      ccClient = await createTestClient({
        clientType: "confidential",
        grantTypes: ["client_credentials"],
      });
      user = await createTestUser();
    });

    it("refuses an ID token as a bearer token, and introspects it as inactive", async () => {
      const { code, verifier } = await browserLogin({
        clientId: publicClient.clientId,
        redirectUri: REDIRECT_URI,
        scope: SCOPE,
        email: user.email,
        password: user.plainPassword,
      });
      const exchanged = await postForm("/oauth/token", {
        grant_type: "authorization_code",
        client_id: publicClient.clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
      const { id_token } = (await exchanged.json()) as { id_token: string };
      expect(id_token).toBeTruthy();

      const userinfo = await fetch(`${BASE_URL}/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${id_token}` },
      });
      expect(userinfo.status).toBe(401);
      expect((await json(userinfo)).error).toBe("invalid_token");

      const account = await fetch(`${BASE_URL}/v1/account/me`, {
        headers: { Authorization: `Bearer ${id_token}` },
      });
      expect(account.status).toBe(401);

      const introspected = await postForm(
        "/oauth/introspect",
        { token: id_token },
        { Authorization: basic(ccClient) }
      );
      expect(introspected.status).toBe(200);
      expect(await json(introspected)).toEqual({ active: false });
    });
  });
});
