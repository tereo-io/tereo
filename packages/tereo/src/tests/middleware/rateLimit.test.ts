// @module-tag int
// @module-tag auth
// @module-tag security

import { BASE_URL, HTTP_STATUS } from "../support/auth.js";
import { describe, it, expect } from "vitest";

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
