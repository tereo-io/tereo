// @module-tag int
// @module-tag auth
// @module-tag security

import { BASE_URL, HTTP_STATUS } from "../support/auth/constants.js";
import { createTestClient } from "../support/auth/clients.js";
import { describe, it, expect } from "vitest";

const TOO_MANY_REQUESTS = 429;

let lastIp = 150;
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

describe("verifyClientSecretLimited", () => {
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
