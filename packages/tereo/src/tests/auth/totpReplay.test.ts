import { absorbCookies, cookieHeader, newPkce } from "../utils/browserLogin.js";
import { encryptTotpSecret, generateTotpSecret } from "../../utils/totp.js";
import type { CookieJar } from "../utils/browserLogin.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  generateTotpCode,
  getUiAccessTokenForUser,
} from "./utils/test-helpers.js";

/**
 * A TOTP code is accepted once: every place that checks one records the
 * code's 30-second step and refuses any code from that step or an earlier one.
 */

const REDIRECT_URI = "http://localhost:3000/callback";

let client: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  client = await createTestClient();
});

const userWithTotp = async () => {
  const user = await createTestUser();
  const secret = generateTotpSecret();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      totpSecret: encryptTotpSecret(secret),
      totpEnabled: true,
      totpEnabledAt: new Date(),
    },
  });
  return { user, secret };
};

/** Password login up to the 2FA page; returns its session token. */
const startLogin = async (
  user: { email: string; plainPassword: string },
  jar: CookieJar
) => {
  const pkce = newPkce();
  const params = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    state: pkce.state,
    scope: "openid",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  };
  const start = await fetch(
    `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
    { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
  );
  absorbCookies(jar, start);
  const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({
      ...params,
      email: user.email,
      password: user.plainPassword,
    }),
  });
  absorbCookies(jar, submit);
  expect(submit.status).toBe(HTTP_STATUS.OK);
  const url = new URL(
    ((await submit.json()) as { redirect_url: string }).redirect_url
  );
  expect(url.pathname).toBe("/login/2fa");
  return url.searchParams.get("session")!;
};

const submitTotp = (jar: CookieJar, session: string, totp_code: string) =>
  fetch(`${BASE_URL}/oauth/totp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({ session_token: session, totp_code }),
  });

describe("TOTP replay at login", () => {
  it("rejects a code already used to sign in, then takes the next step's", async () => {
    const { user, secret } = await userWithTotp();
    const code = generateTotpCode(secret);

    const first = new Map<string, string>();
    const firstSession = await startLogin(user, first);
    expect((await submitTotp(first, firstSession, code)).status).toBe(
      HTTP_STATUS.OK
    );

    const second = new Map<string, string>();
    const secondSession = await startLogin(user, second);
    const replay = await submitTotp(second, secondSession, code);
    expect(replay.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(((await replay.json()) as { error: string }).error).toBe(
      "invalid_code"
    );

    expect(
      (await submitTotp(second, secondSession, generateTotpCode(secret, 1)))
        .status
    ).toBe(HTTP_STATUS.OK);
  });

  it("lets only one of two concurrent logins with the same code through", async () => {
    const { user, secret } = await userWithTotp();
    const jars = [new Map<string, string>(), new Map<string, string>()];
    const sessions = [
      await startLogin(user, jars[0]),
      await startLogin(user, jars[1]),
    ];
    const code = generateTotpCode(secret);

    const statuses = (
      await Promise.all(
        jars.map((jar, i) => submitTotp(jar, sessions[i], code))
      )
    )
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([HTTP_STATUS.OK, HTTP_STATUS.UNAUTHORIZED]);
  });
});

describe("TOTP replay on /account/totp", () => {
  const enable = async () => {
    const user = await createTestUser();
    const token = await getUiAccessTokenForUser(user);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const setup = (await (
      await fetch(`${BASE_URL}/v1/account/totp/setup`, {
        method: "POST",
        headers,
      })
    ).json()) as { secret: string; setupToken: string };
    const code = generateTotpCode(setup.secret);
    const verify = await fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ setupToken: setup.setupToken, totpCode: code }),
    });
    expect(verify.status).toBe(HTTP_STATUS.OK);
    return { user, headers, secret: setup.secret, code };
  };

  it("rejects the code that enabled TOTP when it is used again", async () => {
    const { user, headers, secret, code } = await enable();

    const regenerate = await fetch(
      `${BASE_URL}/v1/account/totp/recovery-codes`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ totpCode: code }),
      }
    );
    expect(regenerate.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(((await regenerate.json()) as { error: string }).error).toBe(
      "invalid_code"
    );

    const disable = (totpCode: string) =>
      fetch(`${BASE_URL}/v1/account/totp`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ totpCode }),
      });
    expect((await disable(code)).status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .totpEnabled
    ).toBe(true);

    expect((await disable(generateTotpCode(secret, 1))).status).toBe(
      HTTP_STATUS.OK
    );
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.totpEnabled).toBe(false);
    expect(stored.totpLastWindow).toBeNull();
  });

  it("rejects a code used for one account action on the next", async () => {
    const { headers, secret } = await enable();
    const next = generateTotpCode(secret, 1);

    const regenerate = await fetch(
      `${BASE_URL}/v1/account/totp/recovery-codes`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ totpCode: next }),
      }
    );
    expect(regenerate.status).toBe(HTTP_STATUS.OK);

    const disable = await fetch(`${BASE_URL}/v1/account/totp`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ totpCode: next }),
    });
    expect(disable.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });
});
