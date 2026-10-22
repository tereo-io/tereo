// @module-tag int
// @module-tag auth
// @module-tag race
import { hashPassword } from "../../../../utils/crypto.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import db from "../../../../utils/db/index.js";
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
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
} from "../../../support/auth.js";

let client: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  client = await createTestClient();
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

describe("POST /oauth/authorize", () => {
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
});
