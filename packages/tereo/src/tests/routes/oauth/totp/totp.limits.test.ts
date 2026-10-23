// @module-tag int
// @module-tag auth
// @module-tag race

import { createTestUser, enableTotp } from "../../../support/auth/users.js";
import { BASE_URL, HTTP_STATUS } from "../../../support/auth/constants.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { generateTotpCode } from "../../../support/auth/crypto.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import {
  type CookieJar,
  absorbCookies,
  cookieHeader,
  newPkce,
} from "../../../support/browserLogin.js";

const REDIRECT_URI = "http://localhost:3000/callback";

const TOO_MANY_REQUESTS = 429;

const MAX_FAILURES = 5;

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

let client: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  client = await createTestClient();
});

describe("POST /oauth/totp/verify", () => {
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
});
