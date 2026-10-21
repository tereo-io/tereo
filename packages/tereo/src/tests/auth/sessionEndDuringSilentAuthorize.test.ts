import { browserLogin, cookieHeader, newPkce } from "../utils/browserLogin.js";
import { LOGIN_CLIENT } from "../../definitions/index.js";
import { getRedisClient } from "../../utils/redis.js";
import { prisma } from "../../utils/db/prisma.js";
import { describe, it, expect } from "vitest";
import {
  BASE_URL,
  createTestUser,
  getUiAccessTokenForUser,
} from "./utils/test-helpers.js";

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
