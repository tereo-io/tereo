import { generateTotpSecret, encryptTotpSecret } from "../../utils/totp.js";
import type { Request, Response as ExpressResponse } from "express";
import { describe, it, expect, beforeAll } from "vitest";
import { hashPassword } from "../../utils/crypto.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import {
  absorbCookies,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../support/browserLogin.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  createUserRequiringTotpSetup,
  generateTotpCode,
  loginToTotpSetup,
} from "../support/auth.js";

/**
 * A password checked just before the password changes must not leave a login
 * step behind: the change's clean-up may run between the check and the step.
 * Each test holds the user's row as a password change does, lets the login
 * check the old password and reach that lock, then changes the password and
 * deletes the user's steps, as endUserSessions does, before letting go.
 */

let client: Awaited<ReturnType<typeof createTestClient>>;
// Imported once Redis is up: the rate limiters it loads take its client.
let totpControllers: typeof import("../../routes/oauth/totp/controllers.js");

beforeAll(async () => {
  client = await createTestClient();
  totpControllers = await import("../../routes/oauth/totp/controllers.js");
});

const startLogin = async (user: { email: string; plainPassword: string }) => {
  const jar: CookieJar = new Map();
  const pkce = newPkce();
  const params = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUris[0],
    state: pkce.state,
    scope: "openid",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  };
  const start = await fetch(
    `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
    { redirect: "manual" }
  );
  absorbCookies(jar, start);
  return fetch(`${BASE_URL}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({
      ...params,
      email: user.email,
      password: user.plainPassword,
    }),
  });
};

/** Waits until some backend is blocked on `holderPid`, or `done` settles. */
const waitForBlocked = async (holderPid: number, done: Promise<unknown>) => {
  let settled = false;
  void done.finally(() => (settled = true));
  for (let i = 0; i < 500 && !settled; i++) {
    const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pg_stat_activity
      WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
    if (count > 0n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** The login's response, with the password changed while it was in flight. */
const loginDuringPasswordChange = async (user: {
  id: string;
  email: string;
  plainPassword: string;
}) => {
  const newHash = await hashPassword("A-New-Password-456!");
  let login!: Promise<Response>;
  await prisma.$transaction(
    async (tx) => {
      await db.users.lockForSessionEnd(tx, { userIds: [user.id] });
      const [{ pid }] = await tx.$queryRaw<
        { pid: number }[]
      >`SELECT pg_backend_pid() AS pid`;
      login = startLogin(user);
      await waitForBlocked(pid, login);
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash },
      });
      await db.loginFlows.deletePendingForUser(user.id, null, tx);
    },
    { timeout: 20_000 }
  );
  return login;
};

describe("a password change during a login", () => {
  it("leaves no consent step from the old password", async () => {
    const user = await createTestUser();

    const res = await loginDuringPasswordChange(user);

    expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(
      await prisma.consentSession.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("leaves no 2FA step from the old password", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        totpSecret: encryptTotpSecret(generateTotpSecret()),
        totpEnabled: true,
        totpEnabledAt: new Date(),
      },
    });

    const res = await loginDuringPasswordChange(user);

    expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(
      await prisma.totpVerification.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("lets a login whose password still holds through", async () => {
    const user = await createTestUser();
    const res = await startLogin(user);
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(
      await prisma.consentSession.count({ where: { userId: user.id } })
    ).toBe(1);
  });
});

/**
 * A password change that starts once the step before is consumed: it is let
 * run until it finishes or waits on a lock, as it would between that consume
 * and the next step's write.
 */
const changePasswordAfter = <A extends unknown[]>(
  userId: string,
  consume: (...args: A) => Promise<boolean>
) => {
  let change: Promise<void> | undefined;
  const consumeThenChange = async (...args: A) => {
    const consumed = await consume(...args);
    let pid: number | undefined;
    let settled = false;
    const newHash = await hashPassword("A-New-Password-456!");
    change = prisma
      .$transaction(
        async (tx) => {
          [{ pid }] = await tx.$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          await db.users.lockForSessionEnd(tx, { userIds: [userId] });
          await tx.user.update({
            where: { id: userId },
            data: { passwordHash: newHash },
          });
          await db.loginFlows.deletePendingForUser(userId, null, tx);
        },
        { timeout: 20_000 }
      )
      .finally(() => (settled = true));
    for (let i = 0; i < 500 && !settled; i++) {
      if (pid !== undefined) {
        const [activity] = await prisma.$queryRaw<
          { wait_event_type: string | null }[]
        >`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}::int`;
        if (activity?.wait_event_type === "Lock") break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return consumed;
  };
  return { consumeThenChange, changed: () => change };
};

/** Calls a handler in-process with the browser's cookies; returns its body. */
const callHandler = async (
  handler: (req: Request, res: ExpressResponse) => Promise<void>,
  body: object,
  jar: CookieJar
) => {
  let json: unknown;
  const res = {
    cookie: () => res,
    clearCookie: () => res,
    status: () => res,
    json: (value: unknown) => {
      json = value;
      return res;
    },
  };
  const req = {
    body,
    cookies: Object.fromEntries(jar),
    headers: {},
    ip: "127.0.0.1",
  };
  await handler(req as unknown as Request, res as unknown as ExpressResponse);
  return json;
};

describe("a password change during the 2FA step", () => {
  it("leaves no consent step from a TOTP code checked before it", async () => {
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
    const pkce = newPkce();
    const params = {
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUris[0],
      state: pkce.state,
      scope: "openid",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    };
    absorbCookies(
      jar,
      await fetch(
        `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
        {
          redirect: "manual",
        }
      )
    );
    const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        ...params,
        email: user.email,
        password: user.plainPassword,
      }),
    });
    absorbCookies(jar, submit);
    const { redirect_url } = (await submit.json()) as { redirect_url: string };
    const sessionToken = new URL(redirect_url).searchParams.get("session");

    const totp = db.totp;
    const race = changePasswordAfter(user.id, totp.consumeVerificationSession);
    (db as { totp: typeof totp }).totp = {
      ...totp,
      consumeVerificationSession: race.consumeThenChange,
    };
    try {
      await callHandler(
        totpControllers.totpVerifyHandler,
        { session_token: sessionToken, totp_code: generateTotpCode(secret) },
        jar
      );
    } finally {
      (db as { totp: typeof totp }).totp = totp;
    }
    await race.changed();

    expect(
      await prisma.consentSession.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("leaves no 2FA setup from a setup grant consumed before it", async () => {
    const user = await createUserRequiringTotpSetup();
    const login = await loginToTotpSetup(user, client);
    const [name, value] = login.grantCookie.split("=");

    const totp = db.totp;
    const race = changePasswordAfter(user.id, totp.consumeSetupGrant);
    (db as { totp: typeof totp }).totp = {
      ...totp,
      consumeSetupGrant: race.consumeThenChange,
    };
    try {
      await callHandler(
        totpControllers.totpSetupInitiateHandler,
        { setup_grant: login.setupGrant },
        new Map([[name, value]])
      );
    } finally {
      (db as { totp: typeof totp }).totp = totp;
    }
    await race.changed();

    expect(
      await prisma.totpSetupSession.count({ where: { userId: user.id } })
    ).toBe(0);
  });
});
