// @module-tag int
// @module-tag auth
// @module-tag race
import { BASE_URL, HTTP_STATUS } from "../../support/auth/constants.js";
import { createTestClient } from "../../support/auth/clients.js";
import { LOGIN_CLIENT } from "../../../definitions/index.js";
import { InvalidGrantError } from "../../../utils/errors.js";
import { createTestUser } from "../../support/auth/users.js";
import { handleRefreshToken } from "../../../utils/auth.js";
import { getRedisClient } from "../../../utils/redis.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import {
  browserLogin,
  cookieHeader,
  newPkce,
} from "../../support/browserLogin.js";
import {
  getUiAccessTokenForUser,
  getAccessTokenForUser,
} from "../../support/auth/login.js";

describe("ending sessions", () => {
  /**
   * A silent authorize issues a code under the browser's SSO session while a
   * logout or sign-out-everywhere ends it. Both must take the user's row before
   * the session rows, or they deadlock and the session end fails with its
   * session still alive.
   */
  const ROUNDS = 6;
  const SILENT_PER_ROUND = 12;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // The rounds run back to back, above the per-IP request limit (per second).
  const clearRequestLimits = async () => {
    const redis = getRedisClient();
    const keys = await redis.keys("tereo:ratelimit*");
    if (keys.length > 0) await redis.del(keys);
  };

  let redirectUri = "";

  const signIn = async () => {
    if (!redirectUri) {
      const loginClient = await prisma.oAuthClient.findFirstOrThrow({
        where: { clientId: LOGIN_CLIENT.clientId },
      });
      redirectUri = loginClient.redirectUris[0];
    }
    const user = await createTestUser();
    const { jar, code, verifier } = await browserLogin({
      clientId: LOGIN_CLIENT.clientId,
      redirectUri,
      scope: "openid",
      email: user.email,
      password: user.plainPassword,
    });
    const ex = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: LOGIN_CLIENT.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    expect(ex.status).toBe(200);
    const { id_token } = (await ex.json()) as { id_token: string };
    return { user, cookies: cookieHeader(jar), idToken: id_token };
  };

  /** prompt=none requests with the SSO cookie, staggered by 1 ms. */
  const silentBurst = (cookies: string) =>
    Array.from({ length: SILENT_PER_ROUND }, async (_, i) => {
      await sleep(i);
      const pkce = newPkce();
      await fetch(
        `${BASE_URL}/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: LOGIN_CLIENT.clientId,
          redirect_uri: redirectUri,
          state: pkce.state,
          scope: "openid",
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
          prompt: "none",
        })}`,
        { redirect: "manual", headers: { Cookie: cookies } }
      );
    });

  describe("session end racing a silent authorize", () => {
    it("logout (end-session with id_token_hint) succeeds and leaves no SSO session", async () => {
      const statuses: number[] = [];
      const leftovers: number[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        await clearRequestLimits();
        const { user, cookies, idToken } = await signIn();
        const logout = (async () => {
          await sleep(SILENT_PER_ROUND / 2);
          const res = await fetch(
            `${BASE_URL}/oauth/end-session?${new URLSearchParams({ id_token_hint: idToken })}`,
            { redirect: "manual", headers: { Cookie: cookies } }
          );
          statuses.push(res.status);
        })();
        await Promise.all([...silentBurst(cookies), logout]);
        leftovers.push(
          await prisma.userSession.count({ where: { userId: user.id } })
        );
      }
      // A navigation with a hint ends at the client's sign-in page.
      expect(statuses, "end-session statuses").toEqual(Array(ROUNDS).fill(302));
      expect(leftovers, "SSO sessions left after logout").toEqual(
        Array(ROUNDS).fill(0)
      );
    }, 180_000);

    it("sign-out-everywhere (DELETE /v1/account/sessions) succeeds while a stolen SSO cookie repeats prompt=none", async () => {
      const statuses: number[] = [];
      const leftovers: number[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        await clearRequestLimits();
        const { user, cookies } = await signIn();
        const uiToken = await getUiAccessTokenForUser(user);
        const signOut = (async () => {
          await sleep(SILENT_PER_ROUND / 2);
          const res = await fetch(`${BASE_URL}/v1/account/sessions`, {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${uiToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ includeCurrentSession: true }),
          });
          statuses.push(res.status);
        })();
        await Promise.all([...silentBurst(cookies), signOut]);
        leftovers.push(
          await prisma.userSession.count({ where: { userId: user.id } })
        );
      }
      expect(statuses, "DELETE /v1/account/sessions statuses").toEqual(
        Array(ROUNDS).fill(200)
      );
      expect(leftovers, "SSO sessions left after sign-out-everywhere").toEqual(
        Array(ROUNDS).fill(0)
      );
    }, 180_000);
  });
});

describe("ending sessions", () => {
  /**
   * Signing out everywhere must also reach the token families being created
   * while it runs: a code obtained just before it, and a refresh in flight.
   */

  const SCOPE = "openid offline_access";

  let client: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async () => {
    client = await createTestClient();
  });

  const signOutOthers = async (bearer: string) => {
    const res = await fetch(`${BASE_URL}/v1/account/sessions`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(res.status).toBeLessThan(300);
  };

  const exchange = (code: string, verifier: string) =>
    fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: client.redirectUris[0],
        client_id: client.clientId,
        code_verifier: verifier,
      }),
    });

  const login = (user: { email: string; plainPassword: string }) =>
    browserLogin({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      scope: SCOPE,
      email: user.email,
      password: user.plainPassword,
    });

  describe("ending sessions while tokens are being issued", () => {
    it("a code obtained before sign-out-everywhere cannot be exchanged after it", async () => {
      const user = await createTestUser();
      const { code, verifier } = await login(user);
      const other = await getAccessTokenForUser(user, client);

      await signOutOthers(other);

      const res = await exchange(code, verifier);
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(((await res.json()) as { error: string }).error).toBe(
        "invalid_grant"
      );
    });

    it("a refresh in flight during sign-out-everywhere leaves no live token", async () => {
      const user = await createTestUser();
      const { code, verifier } = await login(user);
      const tokens = (await (await exchange(code, verifier)).json()) as {
        refresh_token: string;
      };
      const family = await prisma.authorizationCode.findFirstOrThrow({
        where: { userId: user.id, usedAt: { not: null } },
        select: { id: true },
      });
      const other = await getAccessTokenForUser(user, client);
      const clientRecord = await db.clients.getByClientId(client.clientId);

      // The refresh reads its login's context while it runs; the sign-out
      // lands there, between the refresh's start and its new tokens.
      const codes = db.authorizationCode;
      (db as { authorizationCode: typeof codes }).authorizationCode = {
        ...codes,
        getLoginContextById: async (...args) => {
          await signOutOthers(other);
          return codes.getLoginContextById(...args);
        },
      };
      try {
        await expect(
          handleRefreshToken(clientRecord, {
            grant_type: "refresh_token",
            client_id: client.clientId,
            refresh_token: tokens.refresh_token,
          })
        ).rejects.toThrow(InvalidGrantError);
      } finally {
        (db as { authorizationCode: typeof codes }).authorizationCode = codes;
      }

      expect(
        await prisma.refreshToken.count({
          where: { authCodeId: family.id, revokedAt: null },
        })
      ).toBe(0);
    });
  });
});
