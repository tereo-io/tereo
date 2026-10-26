// @module-tag int
// @module-tag auth
// @module-tag race
import { BASE_URL, HTTP_STATUS } from "../../../support/auth/constants.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { browserLogin } from "../../../support/browserLogin.js";
import { createTestUser } from "../../../support/auth/users.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";

describe("POST /oauth/revoke", () => {
  describe("POST /oauth/revoke on a refresh token being refreshed", () => {
    const REDIRECT_URI = "http://localhost:3000/oauth-revoke-family";
    let client: Awaited<ReturnType<typeof createTestClient>>;

    beforeAll(async () => {
      client = await createTestClient({ redirectUris: [REDIRECT_URI] });
    });

    const post = (path: string, body: Record<string, string>) =>
      fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: client.clientId, ...body }),
      });

    /** A family whose SSO session is gone (expired and cleaned up). */
    const familyWithoutSsoSession = async () => {
      const user = await createTestUser();
      const { code, verifier } = await browserLogin({
        clientId: client.clientId,
        redirectUri: REDIRECT_URI,
        scope: "openid offline_access",
        email: user.email,
        password: user.plainPassword,
      });
      const res = await post("/oauth/token", {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
      expect(res.status).toBe(HTTP_STATUS.OK);
      await prisma.userSession.deleteMany({ where: { userId: user.id } });
      const { refresh_token } = (await res.json()) as { refresh_token: string };
      return { user, refreshToken: refresh_token };
    };

    const liveRefreshTokens = (userId: string) =>
      prisma.refreshToken.count({ where: { userId, revokedAt: null } });

    it("revokes the successor of a token rotated before the revocation", async () => {
      const { user, refreshToken } = await familyWithoutSsoSession();
      const refreshed = await post("/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
      expect(refreshed.status).toBe(HTTP_STATUS.OK);

      const revoke = await post("/oauth/revoke", { token: refreshToken });
      expect(revoke.status).toBe(HTTP_STATUS.OK);

      expect(await liveRefreshTokens(user.id)).toBe(0);
    });

    it("leaves no live token of the family when racing a refresh", async () => {
      for (let round = 0; round < 8; round++) {
        const { user, refreshToken } = await familyWithoutSsoSession();
        const [, revoke] = await Promise.all([
          post("/oauth/token", {
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }),
          post("/oauth/revoke", { token: refreshToken }),
        ]);
        expect(revoke.status).toBe(HTTP_STATUS.OK);
        expect(await liveRefreshTokens(user.id)).toBe(0);
      }
    });
  });
});
