// @module-tag int
// @module-tag auth
// @module-tag security

import { BASE_URL, HTTP_STATUS } from "../support/auth/constants.js";
import { getTestPrincipalToken } from "../support/principals.js";
import { prisma } from "../../utils/db/prisma.js";
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";

const TOO_MANY_REQUESTS = 429;
/** Well under the one-second window, so a run inside it cannot have crossed one. */
const WINDOW_MARGIN_MS = 800;

let lastIp = 100;
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

describe("rateLimitPreAuth", () => {
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

describe("rateLimit per-user override", () => {
  const me = (token: string) =>
    fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  const setLimit = (userId: string, rateLimitPerSecond: number | null) =>
    prisma.user.update({ where: { id: userId }, data: { rateLimitPerSecond } });

  const newUser = async (rateLimitPerSecond: number | null) => {
    const userId = randomUUID();
    const token = await getTestPrincipalToken({ userId, permissions: [] });
    await setLimit(userId, rateLimitPerSecond);
    return { userId, token };
  };

  /**
   * Runs `scenario` with a fresh user until it finishes inside one window.
   * The count is fixed per one-second window opened by the user's first
   * request; a run that took longer than the margin may have crossed into a
   * new window, so its result says nothing and it is repeated.
   */
  const inOneWindow = async <T>(
    rateLimitPerSecond: number,
    scenario: (user: { userId: string; token: string }) => Promise<T>
  ): Promise<T> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const user = await newUser(rateLimitPerSecond);
      const start = performance.now();
      const result = await scenario(user);
      if (performance.now() - start < WINDOW_MARGIN_MS) return result;
    }
    throw new Error("Could not finish a scenario inside one rate-limit window");
  };

  it("applies the user's own limit and reports it", async () => {
    const responses = await inOneWindow(3, ({ token }) =>
      Promise.all(Array.from({ length: 4 }, () => me(token)))
    );
    const passed = responses.filter((r) => r.status === HTTP_STATUS.OK);
    const refused = responses.filter((r) => r.status === TOO_MANY_REQUESTS);
    expect(passed).toHaveLength(3);
    expect(refused).toHaveLength(1);
    for (const res of passed) {
      expect(res.headers.get("x-ratelimit-limit")).toBe("3");
    }
    await expectTooMany(refused[0]!);
    expect(refused[0]!.headers.get("x-ratelimit-limit")).toBe("3");
  });

  it("falls back to the default when the override is null", async () => {
    const { token } = await newUser(null);
    const res = await me(token);
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.headers.get("x-ratelimit-limit")).toBe("100");
  });

  it("refuses the next request when the limit is lowered below the count held", async () => {
    const next = await inOneWindow(10, async ({ userId, token }) => {
      const held = await Promise.all(
        Array.from({ length: 6 }, () => me(token))
      );
      expect(held.map((r) => r.status)).toEqual(Array(6).fill(HTTP_STATUS.OK));
      await setLimit(userId, 5);
      return me(token);
    });
    await expectTooMany(next);
  });
});
