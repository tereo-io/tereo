// @module-tag int
// @module-tag auth
// @module-tag security

import { BASE_URL, HTTP_STATUS } from "../support/auth/constants.js";
import { getTestPrincipalToken } from "../support/principals.js";
import { prisma } from "../../utils/db/prisma.js";
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";

const TOO_MANY_REQUESTS = 429;

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

  it("applies the user's own limit and reports it", async () => {
    const { token } = await newUser(3);
    for (let i = 0; i < 3; i++) {
      const res = await me(token);
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.headers.get("x-ratelimit-limit")).toBe("3");
    }
    const refused = await me(token);
    await expectTooMany(refused);
    expect(refused.headers.get("x-ratelimit-limit")).toBe("3");
  });

  it("falls back to the default when the override is null", async () => {
    const { token } = await newUser(null);
    const res = await me(token);
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.headers.get("x-ratelimit-limit")).toBe("100");
  });

  it("refuses the next request when the limit is lowered below the count held", async () => {
    const { userId, token } = await newUser(10);
    for (let i = 0; i < 6; i++) {
      expect((await me(token)).status).toBe(HTTP_STATUS.OK);
    }
    await setLimit(userId, 5);
    await expectTooMany(await me(token));
  });
});
