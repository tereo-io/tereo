// @module-tag int
// @module-tag auth
// @module-tag race

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  type CookieJar,
  absorbCookies,
  cookieHeader,
  newPkce,
} from "../../../support/browserLogin.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
} from "../../../support/auth.js";

const REDIRECT_URI = "http://localhost:3000/callback";

const TOO_MANY_REQUESTS = 429;

const MAX_FAILURES = 5;

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

let client: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  client = await createTestClient();
});

describe("POST /oauth/authorize", () => {
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
