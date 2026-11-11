// @module-tag int
// @module-tag auth
// @module-tag security
import { BASE_URL } from "../support/auth/constants.js";
import { describe, it, expect } from "vitest";
import { randomInt } from "node:crypto";
import env from "../../env.js";

const UI_ORIGIN = new URL(env.UI_BASE_URL).origin;
const CORE_ORIGIN = new URL(env.PUBLIC_URL).origin;
const OTHER_ORIGIN = "http://localhost:4999";

// Not a link core issued: each route answers it as it does any miss.
const JUNK = { token: "a".repeat(43), password: "Str0ng-Passw0rd!x" };

const ROUTES: { path: string; body: Record<string, string> }[] = [
  { path: "/v1/password-setup", body: JUNK },
  { path: "/v1/password-setup/inspect", body: { token: JUNK.token } },
  { path: "/v1/email-verification", body: { token: JUNK.token } },
  { path: "/v1/email-verification/inspect", body: { token: JUNK.token } },
  { path: "/v1/password-reset", body: { email: "nobody@example.com" } },
];

const freshIp = () =>
  `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

// The default TRUST_PROXY (loopback) honours X-Forwarded-For.
const post = (
  { path, body }: (typeof ROUTES)[number],
  headers: Record<string, string>,
  ip = freshIp()
) =>
  fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe("refuseForeignOrigins", () => {
  it("refuses a page at an origin that is not core's, the UI's or listed", async () => {
    const foreign: Record<string, string>[] = [
      { Origin: OTHER_ORIGIN },
      { Origin: OTHER_ORIGIN, "Sec-Fetch-Site": "same-site" },
      { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
      { Origin: "null" },
    ];
    for (const route of ROUTES) {
      for (const headers of foreign) {
        const res = await post(route, headers);
        expect(res.status, `${route.path} ${JSON.stringify(headers)}`).toBe(
          403
        );
        expect(((await res.json()) as { error: string }).error).toBe(
          "forbidden"
        );
      }
    }
  });

  it("passes core, the UI, and a request with no Origin", async () => {
    const allowed: Record<string, string>[] = [
      {},
      { Origin: CORE_ORIGIN },
      { Origin: UI_ORIGIN, "Sec-Fetch-Site": "same-site" },
      { Origin: UI_ORIGIN, "Sec-Fetch-Site": "cross-site" },
      // Reached under a host name other than PUBLIC_URL's.
      { Origin: "http://core.internal:4001", "Sec-Fetch-Site": "same-origin" },
    ];
    for (const route of ROUTES) {
      const expected = (await post(route, {})).status;
      expect(expected, route.path).not.toBe(403);
      for (const headers of allowed) {
        const res = await post(route, headers);
        expect(res.status, `${route.path} ${JSON.stringify(headers)}`).toBe(
          expected
        );
      }
    }
  });

  it("charges no limiter for a refused request", async () => {
    // Each allows 10 misses per IP before answering 429.
    for (const path of [
      "/v1/password-setup/inspect",
      "/v1/email-verification/inspect",
    ]) {
      const route = { path, body: { token: JUNK.token } };
      const miss = (await post(route, {})).status;
      expect(miss, path).not.toBe(429);

      const ip = freshIp();
      for (let i = 0; i < 12; i++) {
        expect((await post(route, { Origin: OTHER_ORIGIN }, ip)).status).toBe(
          403
        );
      }
      expect((await post(route, {}, ip)).status, path).toBe(miss);

      // The same misses with no Origin are counted as before.
      for (let i = 0; i < 12; i++) await post(route, {}, ip);
      expect((await post(route, {}, ip)).status, path).toBe(429);
    }
  });
});
