import { absorbCookies, cookieHeader, newPkce } from "../utils/browserLogin.js";
import { encryptTotpSecret, generateTotpSecret } from "../../utils/totp.js";
import { beginPasswordAttempt } from "../../utils/passwordAttempts.js";
import { getRedisClient, redisKey } from "../../utils/redis.js";
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { CookieJar } from "../utils/browserLogin.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  generateTotpCode,
  getAccessTokenForUser,
  getUiAccessTokenForUser,
} from "./utils/test-helpers.js";

/**
 * Wrong-credential limits: five attempts per window, counted before the
 * credential is checked so concurrent requests cannot outrun the count, and
 * for login 2FA counted per user so a new login does not buy more guesses.
 */

const REDIRECT_URI = "http://localhost:3000/callback";
const TOO_MANY_REQUESTS = 429;
const MAX_FAILURES = 5;

let client: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  client = await createTestClient();
});

const enableTotp = async (userId: string) => {
  const secret = generateTotpSecret();
  await prisma.user.update({
    where: { id: userId },
    data: {
      totpSecret: encryptTotpSecret(secret),
      totpEnabled: true,
      totpEnabledAt: new Date(),
    },
  });
  return secret;
};

const wrongCode = (secret: string) =>
  String((Number(generateTotpCode(secret)) + 500_000) % 1_000_000).padStart(
    6,
    "0"
  );

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

/**
 * One password submission from `ip` (sent as X-Forwarded-For, which the
 * server trusts from loopback), on a fresh authorization session.
 */
const submitPassword = async (
  email: string,
  password: string,
  ip: string,
  headers: Record<string, string> = {}
) => {
  const jar: CookieJar = new Map();
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
    { redirect: "manual", headers: { "X-Forwarded-For": ip } }
  );
  absorbCookies(jar, start);
  return fetch(`${BASE_URL}/oauth/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
      Cookie: cookieHeader(jar),
      ...headers,
    },
    body: JSON.stringify({ ...params, email, password }),
  });
};

let lastIp = 0;
/** A client address no earlier attempt in this file used. */
const freshIp = () => `203.0.113.${++lastIp}`;

const expectTooMany = async (res: Response) => {
  expect(res.status).toBe(TOO_MANY_REQUESTS);
  const retryAfter = Number(res.headers.get("retry-after"));
  expect(retryAfter).toBeGreaterThan(0);
  const body = (await res.json()) as { error: string; retry_after: number };
  expect(body.error).toBe("too_many_requests");
  expect(body.retry_after).toBe(retryAfter);
  return retryAfter;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const submitTotp = (jar: CookieJar, session: string, totp_code: string) =>
  fetch(`${BASE_URL}/oauth/totp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({ session_token: session, totp_code }),
  });

describe("credential failure limits", () => {
  it("counts login 2FA failures per user, across logins", async () => {
    const user = await createTestUser();
    const secret = await enableTotp(user.id);

    const first = new Map<string, string>();
    const firstSession = await startLogin(user, first);
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await submitTotp(first, firstSession, wrongCode(secret));
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    }

    // A fresh login with the password is still locked out of guessing.
    const second = new Map<string, string>();
    const secondSession = await startLogin(user, second);
    const res = await submitTotp(
      second,
      secondSession,
      generateTotpCode(secret)
    );
    await expectTooMany(res);
  });

  it("hands no fresh guesses after the owner's correct code", async () => {
    const user = await createTestUser();
    const secret = await enableTotp(user.id);

    const attacker = new Map<string, string>();
    const attackerSession = await startLogin(user, attacker);
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await submitTotp(
        attacker,
        attackerSession,
        wrongCode(secret)
      );
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    }

    // The owner logs in once the first delay has passed.
    await sleep(1100);
    const owner = new Map<string, string>();
    const ownerSession = await startLogin(user, owner);
    const ok = await submitTotp(owner, ownerSession, generateTotpCode(secret));
    expect(ok.status).toBe(HTTP_STATUS.OK);

    // The count stands: one more guess, and the delay has doubled.
    const next = new Map<string, string>();
    const nextSession = await startLogin(user, next);
    const guess = await submitTotp(next, nextSession, wrongCode(secret));
    expect(guess.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    const retryAfter = await expectTooMany(
      await submitTotp(next, nextSession, wrongCode(secret))
    );
    expect(retryAfter).toBe(2);
  });

  it("lets the owner's known device through a delay an attacker holds", async () => {
    const user = await createTestUser();
    const secret = await enableTotp(user.id);

    // The owner has logged in from this browser before.
    const owner = new Map<string, string>();
    const firstSession = await startLogin(user, owner);
    const first = await submitTotp(
      owner,
      firstSession,
      generateTotpCode(secret)
    );
    expect(first.status).toBe(HTTP_STATUS.OK);
    absorbCookies(owner, first);
    expect(owner.has("tereo_known_device")).toBe(true);

    const attacker = new Map<string, string>();
    const attackerSession = await startLogin(user, attacker);
    for (let i = 0; i < MAX_FAILURES; i++) {
      await submitTotp(attacker, attackerSession, wrongCode(secret));
    }
    await expectTooMany(
      await submitTotp(attacker, attackerSession, wrongCode(secret))
    );

    const ownerSession = await startLogin(user, owner);
    const res = await submitTotp(
      owner,
      ownerSession,
      generateTotpCode(secret, 1)
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
  });

  it("audits repeated login 2FA failures", async () => {
    const user = await createTestUser();
    const secret = await enableTotp(user.id);
    const jar = new Map<string, string>();
    const session = await startLogin(user, jar);
    for (let i = 0; i < MAX_FAILURES; i++) {
      await submitTotp(jar, session, wrongCode(secret));
    }

    const entries = await prisma.auditLogEntry.findMany({
      where: { entityType: "User", entityId: user.id },
    });
    const failures = entries.filter(
      (e) =>
        (e.metadata as { action?: string } | null)?.action === "totp_failures"
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].metadata).toMatchObject({
      method: "totp",
      recentFailures: MAX_FAILURES,
    });
  });

  it("locks POST /account/password after repeated wrong current passwords", async () => {
    const user = await createTestUser();
    const token = await getAccessTokenForUser(user, client);
    const change = (currentPassword: string) =>
      fetch(`${BASE_URL}/v1/account/password`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword,
          newPassword: "AnotherPassword456!",
        }),
      });

    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await change("not-the-password");
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    }
    await expectTooMany(await change(user.plainPassword));

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.passwordHash).toBe(user.passwordHash);
  });

  it("lets no more than the limit through when wrong codes arrive at once", async () => {
    const user = await createTestUser();
    // Disabling 2FA is for core's UI only.
    const token = await getUiAccessTokenForUser(user);
    const secret = await enableTotp(user.id);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        fetch(`${BASE_URL}/v1/account/totp`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ totpCode: wrongCode(secret) }),
        })
      )
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === HTTP_STATUS.BAD_REQUEST)).toHaveLength(
      MAX_FAILURES
    );
    expect(statuses.filter((s) => s === TOO_MANY_REQUESTS)).toHaveLength(
      20 - MAX_FAILURES
    );
  });
});

describe("login password limits", () => {
  const unknownEmail = () => `nobody-${randomUUID()}@test.local`;

  it("refuses a sixth attempt from one client and address, whatever the accounts", async () => {
    const user = await createTestUser();
    const ip = freshIp();
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await submitPassword(unknownEmail(), "wrong-password", ip);
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    }
    await expectTooMany(
      await submitPassword(user.email, user.plainPassword, ip)
    );

    // Another address is not held back by this one.
    const other = await submitPassword(
      user.email,
      user.plainPassword,
      freshIp()
    );
    expect(other.status).toBe(HTTP_STATUS.OK);
  });

  it("keeps a client and address's failures through a correct login to another account", async () => {
    const own = await createTestUser();
    const ip = freshIp();
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      const res = await submitPassword(unknownEmail(), "wrong-password", ip);
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    }
    const ok = await submitPassword(own.email, own.plainPassword, ip);
    expect(ok.status).toBe(HTTP_STATUS.OK);

    // The login spent no attempt, and cleared none: one failure is left.
    const fifth = await submitPassword(unknownEmail(), "wrong-password", ip);
    expect(fifth.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    await expectTooMany(
      await submitPassword(unknownEmail(), "wrong-password", ip)
    );
    await expectTooMany(await submitPassword(own.email, own.plainPassword, ip));
  });

  it("never refuses correct logins from one client and address for their number", async () => {
    const user = await createTestUser();
    const ip = freshIp();
    for (let i = 0; i < MAX_FAILURES * 2; i++) {
      const res = await submitPassword(user.email, user.plainPassword, ip);
      expect(res.status).toBe(HTTP_STATUS.OK);
    }
  });

  it("counts per the body's client, whatever Basic header comes with it", async () => {
    const user = await createTestUser();
    const ip = freshIp();
    const randomBasic = () => ({
      Authorization: `Basic ${Buffer.from(`${randomUUID()}:x`).toString("base64")}`,
    });
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await submitPassword(
        unknownEmail(),
        "wrong-password",
        ip,
        randomBasic()
      );
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    }
    await expectTooMany(
      await submitPassword(user.email, user.plainPassword, ip, randomBasic())
    );
  });

  it("backs off an account's failures across addresses, doubling the delay", async () => {
    const user = await createTestUser();
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await submitPassword(user.email, "wrong-password", freshIp());
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    }
    // Even the right password waits, from a new address and in another case.
    const first = await expectTooMany(
      await submitPassword(
        user.email.toUpperCase(),
        user.plainPassword,
        freshIp()
      )
    );
    expect(first).toBe(1);

    await sleep(first * 1000 + 100);
    const after = await submitPassword(user.email, "wrong-password", freshIp());
    expect(after.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    const second = await expectTooMany(
      await submitPassword(user.email, user.plainPassword, freshIp())
    );
    expect(second).toBe(2);
  });

  it("clears an account's count on a correct password", async () => {
    const user = await createTestUser();
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      const res = await submitPassword(user.email, "wrong-password", freshIp());
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    }
    const ok = await submitPassword(user.email, user.plainPassword, freshIp());
    expect(ok.status).toBe(HTTP_STATUS.OK);

    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await submitPassword(user.email, "wrong-password", freshIp());
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    }
    await expectTooMany(
      await submitPassword(user.email, user.plainPassword, freshIp())
    );
  });

  it("answers an unknown email exactly as it does a real one", async () => {
    const user = await createTestUser();
    const run = async (email: string) => {
      const answers: Array<{ status: number; body: unknown }> = [];
      for (let i = 0; i <= MAX_FAILURES; i++) {
        const res = await submitPassword(email, "wrong-password", freshIp());
        answers.push({ status: res.status, body: await res.json() });
      }
      return answers;
    };

    const known = await run(user.email);
    const unknown = await run(unknownEmail());
    expect(unknown).toEqual(known);
    expect(known.map((a) => a.status)).toEqual([
      ...Array<number>(MAX_FAILURES).fill(HTTP_STATUS.UNAUTHORIZED),
      TOO_MANY_REQUESTS,
    ]);
  });

  it("lets no more than the free attempts through when they arrive at once", async () => {
    const user = await createTestUser();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        submitPassword(user.email, "wrong-password", freshIp())
      )
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === HTTP_STATUS.UNAUTHORIZED)).toHaveLength(
      MAX_FAILURES
    );
    expect(statuses.filter((s) => s === TOO_MANY_REQUESTS)).toHaveLength(
      12 - MAX_FAILURES
    );
  });
});

describe("per-address limit before authentication", () => {
  it("throttles a flood of unauthenticated requests from one address", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    let limited: Response | undefined;
    // In batches, so the flood lands inside the one-second window without
    // opening hundreds of sockets at once.
    for (let batch = 0; batch < 10 && !limited; batch++) {
      const responses = await Promise.all(
        Array.from({ length: 50 }, () =>
          fetch(`${BASE_URL}/v1/audit/entries`, {
            headers: { "X-Forwarded-For": ip },
          })
        )
      );
      for (const res of responses) {
        statuses.push(res.status);
        if (res.status === TOO_MANY_REQUESTS && !limited) limited = res;
        else await res.body?.cancel();
      }
    }
    expect(new Set(statuses)).toEqual(
      new Set([HTTP_STATUS.UNAUTHORIZED, TOO_MANY_REQUESTS])
    );
    await expectTooMany(limited!);

    // Other addresses are unaffected.
    const other = await fetch(`${BASE_URL}/v1/audit/entries`, {
      headers: { "X-Forwarded-For": freshIp() },
    });
    expect(other.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });
});

describe("client secret failure limit", () => {
  const CLIENT_SECRET_FAILURES = 10;

  const basic = (clientId: string, secret: string) =>
    `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;

  const clientCredentials = (clientId: string, secret: string, ip: string) =>
    fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basic(clientId, secret),
        "X-Forwarded-For": ip,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });

  const introspect = (clientId: string, secret: string, ip: string) =>
    fetch(`${BASE_URL}/oauth/introspect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basic(clientId, secret),
        "X-Forwarded-For": ip,
      },
      body: new URLSearchParams({ token: "not-a-token" }),
    });

  it("refuses a client and IP after repeated wrong secrets, even with the right one", async () => {
    const confidential = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
    });
    const ip = freshIp();

    for (let i = 0; i < CLIENT_SECRET_FAILURES; i++) {
      const res = await clientCredentials(
        confidential.clientId,
        "wrong-secret",
        ip
      );
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    }

    // The right secret is refused before it is checked.
    await expectTooMany(
      await clientCredentials(
        confidential.clientId,
        confidential.plainSecret!,
        ip
      )
    );
    // The same counter guards the other client-authenticated endpoints.
    await expectTooMany(
      await introspect(confidential.clientId, confidential.plainSecret!, ip)
    );

    // Another address is not locked out of the client.
    const other = await clientCredentials(
      confidential.clientId,
      confidential.plainSecret!,
      freshIp()
    );
    expect(other.status).toBe(HTTP_STATUS.OK);
  });

  it("lets any number of concurrent correct secrets from one address through", async () => {
    const confidential = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
    });
    const ip = freshIp();

    const results = await Promise.all(
      Array.from({ length: CLIENT_SECRET_FAILURES + 5 }, () =>
        introspect(confidential.clientId, confidential.plainSecret!, ip)
      )
    );
    expect(results.map((r) => r.status)).toEqual(
      results.map(() => HTTP_STATUS.OK)
    );
  });

  it("clears the count on a successful authentication", async () => {
    const confidential = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
    });
    const ip = freshIp();

    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < CLIENT_SECRET_FAILURES - 1; i++) {
        const res = await introspect(confidential.clientId, "wrong", ip);
        expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      }
      const ok = await clientCredentials(
        confidential.clientId,
        confidential.plainSecret!,
        ip
      );
      expect(ok.status).toBe(HTTP_STATUS.OK);
    }
  });
});

describe("failed password auditing", () => {
  const passwordFailures = async (userId: string) =>
    (
      await prisma.auditLogEntry.findMany({
        where: { entityType: "User", entityId: userId },
      })
    ).filter(
      (e) =>
        (e.metadata as { action?: string } | null)?.action ===
        "password_failures"
    );

  const failuresTtl = (userId: string) =>
    getRedisClient().ttl(redisKey("password:failures", userId));

  it("gives the count of wrong passwords an expiry", async () => {
    const user = await createTestUser();
    await submitPassword(user.email, "wrong-password", freshIp());
    expect(await failuresTtl(user.id)).toBeGreaterThan(0);
  });

  it("sets the count and its expiry together", async () => {
    const user = await createTestUser();
    // A lone EXPIRE lost after its INCR would leave the count forever.
    const expire = vi
      .spyOn(getRedisClient(), "expire")
      .mockRejectedValue(new Error("connection lost"));
    try {
      await beginPasswordAttempt(
        { ip: freshIp() } as Request,
        user,
        "login"
      ).failed("invalid_password");
    } finally {
      expire.mockRestore();
    }
    expect(await failuresTtl(user.id)).toBeGreaterThan(0);
  });

  it("audits a known user's fifth wrong login password in a row", async () => {
    const user = await createTestUser();
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      await submitPassword(user.email, "wrong-password", freshIp());
    }
    expect(await passwordFailures(user.id)).toHaveLength(0);

    const res = await submitPassword(user.email, "wrong-password", freshIp());
    expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    const failures = await passwordFailures(user.id);
    expect(failures).toHaveLength(1);
    expect(failures[0].metadata).toMatchObject({
      check: "login",
      reason: "invalid_password",
      consecutiveFailures: MAX_FAILURES,
    });
  });

  it("starts the run over after a correct password", async () => {
    const user = await createTestUser();
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      await submitPassword(user.email, "wrong-password", freshIp());
    }
    const ok = await submitPassword(user.email, user.plainPassword, freshIp());
    expect(ok.status).toBe(HTTP_STATUS.OK);
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      await submitPassword(user.email, "wrong-password", freshIp());
    }
    expect(await passwordFailures(user.id)).toHaveLength(0);
  });

  it("audits nothing for an email no account has", async () => {
    const email = `nobody-${randomUUID()}@test.local`;
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await submitPassword(email, "wrong-password", freshIp());
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    }
    expect(
      await prisma.auditLogEntry.count({ where: { entityName: email } })
    ).toBe(0);
  });

  it("audits repeated wrong current passwords at POST /account/password", async () => {
    const user = await createTestUser();
    const token = await getAccessTokenForUser(user, client);
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await fetch(`${BASE_URL}/v1/account/password`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: "not-the-password",
          newPassword: "AnotherPassword456!",
        }),
      });
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    }
    const failures = await passwordFailures(user.id);
    expect(failures).toHaveLength(1);
    expect(failures[0].metadata).toMatchObject({
      check: "password_change",
      reason: "invalid_password",
      consecutiveFailures: MAX_FAILURES,
    });
  });
});
