import { generateRandomString, hashFlowToken } from "../../utils/crypto.js";
import type { Request, Response as ExpressResponse } from "express";
import { ensureTestOrganization } from "../support/principals.js";
import { describe, it, expect, beforeAll } from "vitest";
import { hashPassword } from "../../utils/crypto.js";
import { newPkce } from "../support/browserLogin.js";
import { OAuth2Error } from "../../utils/errors.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import {
  createTestClient,
  createTestUser,
  generateUniqueId,
} from "../support/auth.js";

/**
 * The consent and org-select steps are consumed under the user's lock, in
 * the transaction that issues the code or writes the next step. Each test
 * changes the password and deletes the user's steps, as `endUserSessions`
 * does, after the handler has read its step and before it takes that lock.
 */

let consentControllers: typeof import("../../routes/oauth/consent/controllers.js");
let orgSelectControllers: typeof import("../../routes/oauth/org-select/controllers.js");

beforeAll(async () => {
  consentControllers =
    await import("../../routes/oauth/consent/controllers.js");
  orgSelectControllers =
    await import("../../routes/oauth/org-select/controllers.js");
});

const changePassword = async (userId: string) => {
  const newHash = await hashPassword("A-New-Password-456!");
  await prisma.$transaction(async (tx) => {
    await db.users.lockForSessionEnd(tx, { userIds: [userId] });
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash: newHash },
    });
    await db.loginFlows.deletePendingForUser(userId, null, tx);
  });
};

/** Waits until `change` waits on a row lock, or settles. */
const untilBlockedOrDone = async (change: Promise<void>) => {
  let settled = false;
  void change.finally(() => (settled = true));
  for (let i = 0; i < 500 && !settled; i++) {
    const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'
        AND datname = current_database()`;
    if (count > 0n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Calls a handler in-process with the given cookies; returns its error. */
const callHandler = async (
  handler: (req: Request, res: ExpressResponse) => Promise<void>,
  body: object,
  cookies: Record<string, string>
): Promise<unknown> => {
  const res = {
    cookie: () => res,
    clearCookie: () => res,
    status: () => res,
    json: () => res,
  };
  const req = { body, cookies, headers: {}, ip: "127.0.0.1", method: "POST" };
  try {
    await handler(req as unknown as Request, res as unknown as ExpressResponse);
    return null;
  } catch (err) {
    return err;
  }
};

/** Replaces one function of a db module for the length of `run`. */
const replacing = async <K extends keyof typeof db>(
  key: K,
  fn: string,
  wrap: (original: (...args: never[]) => Promise<unknown>) => unknown,
  run: () => Promise<unknown>
) => {
  const original = db[key];
  const inner = (original as unknown as Record<string, never>)[fn];
  (db as Record<K, unknown>)[key] = { ...original, [fn]: wrap(inner) };
  try {
    return await run();
  } finally {
    (db as Record<K, unknown>)[key] = original;
  }
};

/**
 * The password changes just before the code's transaction takes the user's
 * lock: after the step was read, and after a consume made outside the lock.
 */
const changingPasswordBeforeIssue = (
  userId: string,
  run: () => Promise<unknown>
) =>
  replacing(
    "users",
    "lockForTokenIssue",
    (lock) =>
      async (...args: never[]) => {
        await changePassword(userId);
        return lock(...args);
      },
    run
  );

const flowFields = (redirectUri: string) => {
  const pkce = newPkce();
  return {
    redirectUri,
    scopes: ["openid"],
    state: generateUniqueId(),
    codeChallenge: pkce.challenge,
    codeChallengeMethod: "S256",
    nonce: null,
    authTime: new Date(),
    maxAge: null,
    acrValues: null,
    prompt: null,
    authMethods: ["pwd"],
    expiresAt: new Date(Date.now() + 120_000),
  };
};

const codesFor = (userId: string) =>
  prisma.authorizationCode.count({ where: { userId } });

describe("a password change during the consent step", () => {
  it("refuses the approval and issues no code", async () => {
    const client = await createTestClient();
    const user = await createTestUser();
    const token = generateRandomString(32);
    await db.consent.createConsentSession({
      sessionToken: token,
      userId: user.id,
      clientId: client.id,
      ...flowFields(client.redirectUris[0]),
    });

    const err = await changingPasswordBeforeIssue(user.id, () =>
      callHandler(
        consentControllers.consentPostHandler,
        { session_token: token, approved: true },
        { [`tereo_consent_session_${client.clientId}`]: token }
      )
    );

    expect(err).toBeInstanceOf(OAuth2Error);
    expect((err as OAuth2Error).code).toBe("invalid_session");
    expect(await codesFor(user.id)).toBe(0);
    expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(
      0
    );
  });
});

describe("a password change during the org-select step", () => {
  const orgSelectSession = async (
    client: Awaited<ReturnType<typeof createTestClient>>
  ) => {
    const user = await createTestUser();
    const orgId = await ensureTestOrganization(`step-lock-${user.id}`);
    await prisma.organizationMember.create({
      data: { organizationId: orgId, userId: user.id },
    });
    const token = generateRandomString(32);
    await prisma.orgSelectionSession.create({
      data: {
        tokenHash: hashFlowToken(token),
        userId: user.id,
        clientId: client.id,
        ...flowFields(client.redirectUris[0]),
      },
    });
    return { user, orgId, token };
  };

  const submit = (
    client: Awaited<ReturnType<typeof createTestClient>>,
    { orgId, token }: Awaited<ReturnType<typeof orgSelectSession>>
  ) =>
    callHandler(
      orgSelectControllers.orgSelectSubmitHandler,
      { session_token: token, organization_id: orgId },
      { [`tereo_org_select_session_${client.clientId}`]: token }
    );

  it("writes no consent step", async () => {
    const client = await createTestClient();
    const session = await orgSelectSession(client);

    // Started as the consent step is written, and let run until it waits
    // on the step's lock or finishes.
    let change: Promise<void> | undefined;
    await replacing(
      "consent",
      "createConsentSession",
      (create) =>
        async (...args: never[]) => {
          change = changePassword(session.user.id);
          await untilBlockedOrDone(change);
          return create(...args);
        },
      () => submit(client, session)
    );
    await change;

    expect(
      await prisma.consentSession.count({ where: { userId: session.user.id } })
    ).toBe(0);
  });

  it("issues no code to a client that skips consent", async () => {
    const client = await createTestClient();
    await prisma.oAuthClient.update({
      where: { id: client.id },
      data: { consentRequired: false },
    });
    const session = await orgSelectSession(client);

    const err = await changingPasswordBeforeIssue(session.user.id, () =>
      submit(client, session)
    );

    expect((err as OAuth2Error).code).toBe("invalid_session");
    expect(await codesFor(session.user.id)).toBe(0);
  });
});
