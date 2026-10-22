// @module-tag int
// @module-tag auth
// @module-tag security

import { beginPasswordAttempt } from "../../utils/passwordAttempts.js";
import { getRedisClient, redisKey } from "../../utils/redis.js";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "node:crypto";
import { type Request } from "express";
import {
  type CookieJar,
  absorbCookies,
  cookieHeader,
  newPkce,
} from "../support/browserLogin.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  getAccessTokenForUser,
} from "../support/auth.js";

const REDIRECT_URI = "http://localhost:3000/callback";

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

let lastIp = 200;
/** A client address no earlier attempt in this file used. */
const freshIp = () => `203.0.113.${++lastIp}`;

let client: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  client = await createTestClient();
});

describe("beginPasswordAttempt", () => {
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
