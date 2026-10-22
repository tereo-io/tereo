import { encryptTotpSecret, generateTotpSecret } from "../../utils/totp.js";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { CookieJar } from "../support/browserLogin.js";
import { describe, it, expect, beforeAll } from "vitest";
import { normalizeEmail } from "../../utils/email.js";
import { getRedisClient } from "../../utils/redis.js";
import { prisma } from "../../utils/db/prisma.js";
import env from "../../env.js";
import {
  absorbCookies,
  cookieHeader,
  newPkce,
} from "../support/browserLogin.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  generateTotpCode,
  getAccessTokenForUser,
} from "../support/auth.js";

/**
 * The known-device cookie lets a browser that has logged in as an account
 * before through that account's login backoff, and nothing
 * else: not another account, not a forged or stale cookie, not past its own
 * failure cap, and not once the password has changed.
 */

const REDIRECT_URI = "http://localhost:3000/callback";
const TOO_MANY_REQUESTS = 429;
const KNOWN_DEVICE_COOKIE = "tereo_known_device";
const MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

let client: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  client = await createTestClient();
});

let lastIp = 0;
const freshIp = () => `198.51.100.${++lastIp}`;

const backoffKey = (email: string) =>
  `rl:login:account:${createHash("sha256").update(normalizeEmail(email)).digest("hex")}`;

/** Puts the account deep into backoff, as a persistent attacker would. */
const holdInBackoff = async (email: string) => {
  await getRedisClient().hset(backoffKey(email), {
    failures: 20,
    next: Date.now() + 15 * 60 * 1000,
  });
};

const backoffFailures = async (email: string) =>
  Number(await getRedisClient().hget(backoffKey(email), "failures"));

/** One login submission from `jar`'s browser, on a fresh authorize session. */
const submitLogin = async (
  jar: CookieJar,
  email: string,
  password: string,
  ip = freshIp()
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
    {
      redirect: "manual",
      headers: { "X-Forwarded-For": ip, Cookie: cookieHeader(jar) },
    }
  );
  absorbCookies(jar, start);
  const res = await fetch(`${BASE_URL}/oauth/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
      Cookie: cookieHeader(jar),
    },
    body: JSON.stringify({ ...params, email, password }),
  });
  absorbCookies(jar, res);
  return res;
};

/** A browser that has logged in as `user` once. */
const knownBrowser = async (user: { email: string; plainPassword: string }) => {
  const jar: CookieJar = new Map();
  const res = await submitLogin(jar, user.email, user.plainPassword);
  expect(res.status).toBe(HTTP_STATUS.OK);
  expect(jar.get(KNOWN_DEVICE_COOKIE)).toBeTruthy();
  return jar;
};

const signed = (userId: string, issuedAt: number, passwordHash: string) =>
  `${userId}.${issuedAt}.${createHmac(
    "sha256",
    Buffer.from(env.KNOWN_DEVICE_KEY, "base64")
  )
    .update(`known-device\n${userId}\n${issuedAt}\n${passwordHash}`)
    .digest("base64url")}`;

const withCookie = (token: string): CookieJar =>
  new Map([[KNOWN_DEVICE_COOKIE, token]]);

const expectTooMany = async (res: Response) => {
  expect(res.status).toBe(TOO_MANY_REQUESTS);
  expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(((await res.json()) as { error: string }).error).toBe(
    "too_many_requests"
  );
};

describe("known-device login", () => {
  it("sets a long-lived httpOnly cookie, scoped to /oauth, after a login", async () => {
    const user = await createTestUser();
    const res = await submitLogin(new Map(), user.email, user.plainPassword);
    expect(res.status).toBe(HTTP_STATUS.OK);

    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${KNOWN_DEVICE_COOKIE}=`));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    expect(cookie).toMatch(/; Path=\/oauth(;|$)/);
    expect(cookie).toMatch(new RegExp(`; Max-Age=${MAX_AGE_SECONDS}(;|$)`));
  });

  it("lets a known browser with the right password through the account's backoff", async () => {
    const user = await createTestUser();
    const jar = await knownBrowser(user);
    await holdInBackoff(user.email);

    // Any other browser waits, right password or not.
    await expectTooMany(
      await submitLogin(new Map(), user.email, user.plainPassword)
    );

    const res = await submitLogin(jar, user.email, user.plainPassword);
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(
      ((await res.json()) as { redirect_url: string }).redirect_url
    ).toBeTruthy();

    // The success cleared the account's backoff for everyone.
    const fresh = await submitLogin(new Map(), user.email, user.plainPassword);
    expect(fresh.status).toBe(HTTP_STATUS.OK);
  });

  it("does not bypass for another account's cookie", async () => {
    const owner = await createTestUser();
    const victim = await createTestUser();
    const jar = await knownBrowser(owner);
    await holdInBackoff(victim.email);

    await expectTooMany(
      await submitLogin(jar, victim.email, victim.plainPassword)
    );
  });

  it("does not bypass for a forged, altered or expired cookie", async () => {
    const user = await createTestUser();
    await holdInBackoff(user.email);
    const now = Math.floor(Date.now() / 1000);
    const valid = signed(user.id, now, user.passwordHash);
    const [, , signature] = valid.split(".");

    const cookies = [
      `${user.id}.${now}.${"A".repeat(43)}`,
      // The signature of one issue time on another.
      `${user.id}.${now + 1}.${signature}`,
      // Signed with the user id but not the password hash.
      signed(user.id, now, ""),
      signed(user.id, now - MAX_AGE_SECONDS - 60, user.passwordHash),
      signed(randomUUID(), now, user.passwordHash),
      "garbage",
    ];
    for (const token of cookies) {
      await expectTooMany(
        await submitLogin(withCookie(token), user.email, user.plainPassword)
      );
    }

    // The same construction, correctly signed and current, does bypass.
    const res = await submitLogin(
      withCookie(valid),
      user.email,
      user.plainPassword
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
  });

  it("caps a known browser's wrong passwords, and still counts them against the account", async () => {
    const user = await createTestUser();
    const jar = await knownBrowser(user);
    await holdInBackoff(user.email);
    const before = await backoffFailures(user.email);

    for (let i = 0; i < 5; i++) {
      const res = await submitLogin(jar, user.email, "wrong-password");
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    }
    expect(await backoffFailures(user.email)).toBe(before + 5);

    // Past the cap, even the right password waits, from any address.
    await expectTooMany(await submitLogin(jar, user.email, user.plainPassword));
    await expectTooMany(
      await submitLogin(new Map(), user.email, user.plainPassword)
    );
  });

  it("forgets known browsers when the password changes", async () => {
    const user = await createTestUser();
    const jar = await knownBrowser(user);
    const token = await getAccessTokenForUser(user, client);

    const newPassword = "AnotherPassword456!";
    const change = await fetch(`${BASE_URL}/v1/account/password`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        newPassword,
      }),
    });
    expect(change.status).toBe(HTTP_STATUS.OK);

    await holdInBackoff(user.email);
    await expectTooMany(await submitLogin(jar, user.email, newPassword));
  });

  it("sets the cookie only once 2FA is done, when 2FA is required", async () => {
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

    const jar: CookieJar = new Map();
    const res = await submitLogin(jar, user.email, user.plainPassword);
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(jar.has(KNOWN_DEVICE_COOKIE)).toBe(false);
    const session = new URL(
      ((await res.json()) as { redirect_url: string }).redirect_url
    ).searchParams.get("session")!;

    const verify = await fetch(`${BASE_URL}/oauth/totp/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        session_token: session,
        totp_code: generateTotpCode(secret),
      }),
    });
    absorbCookies(jar, verify);
    expect(verify.status).toBe(HTTP_STATUS.OK);
    expect(jar.has(KNOWN_DEVICE_COOKIE)).toBe(true);

    await holdInBackoff(user.email);
    const again = await submitLogin(jar, user.email, user.plainPassword);
    expect(again.status).toBe(HTTP_STATUS.OK);
  });
});
