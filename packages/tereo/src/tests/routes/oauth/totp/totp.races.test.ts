// @module-tag int
// @module-tag auth
// @module-tag race
import { BASE_URL, HTTP_STATUS } from "../../../support/auth/constants.js";
import type { Request, Response as ExpressResponse } from "express";
import { createTestClient } from "../../../support/auth/clients.js";
import { generateTotpCode } from "../../../support/auth/crypto.js";
import { createTestUser } from "../../../support/auth/users.js";
import { hashPassword } from "../../../../utils/crypto.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import db from "../../../../utils/db/index.js";
import {
  createUserRequiringTotpSetup,
  loginToTotpSetup,
} from "../../../support/auth/totpSetup.js";
import {
  absorbCookies,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../../../support/browserLogin.js";
import {
  generateTotpSecret,
  encryptTotpSecret,
} from "../../../../utils/totp.js";

describe("/oauth/totp", () => {
  let client: Awaited<ReturnType<typeof createTestClient>>;
  // Imported once Redis is up: the rate limiters it loads take its client.
  let totpControllers: typeof import("../../../../routes/oauth/totp/controllers.js");

  beforeAll(async () => {
    client = await createTestClient();
    totpControllers =
      await import("../../../../routes/oauth/totp/controllers.js");
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
      const { redirect_url } = (await submit.json()) as {
        redirect_url: string;
      };
      const sessionToken = new URL(redirect_url).searchParams.get("session");

      const totp = db.totp;
      const race = changePasswordAfter(
        user.id,
        totp.consumeVerificationSession
      );
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
});

describe("/oauth/totp", () => {
  const REDIRECT_URI = "http://localhost:3000/callback";

  let client: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async () => {
    client = await createTestClient();
  });

  const userWithTotp = async () => {
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
    return { user, secret };
  };

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
    expect(submit.status).toBe(HTTP_STATUS.OK);
    const url = new URL(
      ((await submit.json()) as { redirect_url: string }).redirect_url
    );
    expect(url.pathname).toBe("/login/2fa");
    return url.searchParams.get("session")!;
  };

  const submitTotp = (jar: CookieJar, session: string, totp_code: string) =>
    fetch(`${BASE_URL}/oauth/totp/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({ session_token: session, totp_code }),
    });

  describe("TOTP replay at login", () => {
    it("rejects a code already used to sign in, then takes the next step's", async () => {
      const { user, secret } = await userWithTotp();
      const code = generateTotpCode(secret);

      const first = new Map<string, string>();
      const firstSession = await startLogin(user, first);
      expect((await submitTotp(first, firstSession, code)).status).toBe(
        HTTP_STATUS.OK
      );

      const second = new Map<string, string>();
      const secondSession = await startLogin(user, second);
      const replay = await submitTotp(second, secondSession, code);
      expect(replay.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(((await replay.json()) as { error: string }).error).toBe(
        "invalid_code"
      );

      expect(
        (await submitTotp(second, secondSession, generateTotpCode(secret, 1)))
          .status
      ).toBe(HTTP_STATUS.OK);
    });

    it("lets only one of two concurrent logins with the same code through", async () => {
      const { user, secret } = await userWithTotp();
      const jars = [new Map<string, string>(), new Map<string, string>()];
      const sessions = [
        await startLogin(user, jars[0]),
        await startLogin(user, jars[1]),
      ];
      const code = generateTotpCode(secret);

      const statuses = (
        await Promise.all(
          jars.map((jar, i) => submitTotp(jar, sessions[i], code))
        )
      )
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([HTTP_STATUS.OK, HTTP_STATUS.UNAUTHORIZED]);
    });
  });
});
