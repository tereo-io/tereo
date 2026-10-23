// @module-tag int
// @module-tag auth
// @module-tag race
import { postForm, loginAndExchange } from "../../../support/auth/login.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { browserLogin } from "../../../support/browserLogin.js";
import { createTestUser } from "../../../support/auth/users.js";
import { describe, it, expect, beforeAll } from "vitest";

const SCOPE = "openid profile email offline_access";
const REDIRECT_URI = "http://localhost:3000/callback";

type Client = Awaited<ReturnType<typeof createTestClient>>;

let publicClient: Client;
let user: Awaited<ReturnType<typeof createTestUser>>;

beforeAll(async () => {
  publicClient = await createTestClient({ redirectUris: [REDIRECT_URI] });
  user = await createTestUser();
});

describe("POST /oauth/token", () => {
  describe("Single-use grants", () => {
    it("redeems a code once when two exchanges race", async () => {
      const { code, verifier } = await browserLogin({
        clientId: publicClient.clientId,
        redirectUri: REDIRECT_URI,
        scope: SCOPE,
        email: user.email,
        password: user.plainPassword,
      });
      const exchange = () =>
        postForm("/oauth/token", {
          grant_type: "authorization_code",
          client_id: publicClient.clientId,
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        });
      const statuses = (await Promise.all([exchange(), exchange()]))
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([200, 400]);
    });

    it("rotates a refresh token once when two refreshes race", async () => {
      const tokens = await loginAndExchange(
        publicClient,
        user,
        REDIRECT_URI,
        SCOPE
      );
      const refresh = () =>
        postForm("/oauth/token", {
          grant_type: "refresh_token",
          client_id: publicClient.clientId,
          refresh_token: tokens.refresh_token,
        });
      const statuses = (await Promise.all([refresh(), refresh()]))
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([200, 400]);
    });
  });
});
