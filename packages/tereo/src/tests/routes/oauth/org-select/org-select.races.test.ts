// @module-tag int
// @module-tag auth
// @module-tag race
import { BASE_URL, HTTP_STATUS } from "../../../support/auth/constants.js";
import { ensureTestOrganization } from "../../../support/principals.js";
import { getAccessTokenForUser } from "../../../support/auth/login.js";
import type { Request, Response as ExpressResponse } from "express";
import { createTestClient } from "../../../support/auth/clients.js";
import { generateUniqueId } from "../../../support/auth/crypto.js";
import { newPkce } from "../../../support/browserLogin.js";
import { OAuth2Error } from "../../../../utils/errors.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import db from "../../../../utils/db/index.js";
import {
  createTestOrganization,
  addTestOrgMember,
} from "../../../support/auth/organizations.js";
import {
  createTestUser,
  createAdminUser,
} from "../../../support/auth/users.js";
import {
  generateRandomString,
  hashFlowToken,
  hashPassword,
} from "../../../../utils/crypto.js";

describe("/oauth/org-select and /oauth/org-select/submit", () => {
  describe("OAuth Org Select Endpoints", () => {
    let testClient: Awaited<ReturnType<typeof createTestClient>>;
    let adminUser: Awaited<ReturnType<typeof createAdminUser>>;
    let adminToken: string;

    beforeAll(async () => {
      testClient = await createTestClient();
      adminUser = await createAdminUser();
      adminToken = await getAccessTokenForUser(adminUser, testClient);
    });

    async function createOrgSelectSession(
      userId: string,
      clientInternalId: string,
      options: { expiresInMs?: number } = {}
    ) {
      const sessionToken = generateRandomString(32);
      const expiresAt = new Date(Date.now() + (options.expiresInMs ?? 120_000));

      const session = await prisma.orgSelectionSession.create({
        data: {
          tokenHash: hashFlowToken(sessionToken),
          userId,
          clientId: clientInternalId,
          redirectUri: "http://localhost:3000/callback",
          scopes: ["openid", "profile"],
          state: generateUniqueId(),
          codeChallenge: "test-challenge",
          codeChallengeMethod: "S256",
          nonce: null,
          authTime: new Date(),
          maxAge: null,
          acrValues: null,
          prompt: null,
          authMethods: ["password"],
          expiresAt,
        },
      });

      return { session, sessionToken };
    }

    // ===========================================================================
    // POST /oauth/org-select/submit
    // ===========================================================================

    describe("POST /oauth/org-select/submit", () => {
      it("lets only one of two concurrent submits of a session through", async () => {
        const org = await createTestOrganization(adminToken);
        const user = await createTestUser();
        await addTestOrgMember(adminToken, org.id, user.id);
        const { sessionToken } = await createOrgSelectSession(
          user.id,
          testClient.id
        );

        const submit = () =>
          fetch(`${BASE_URL}/oauth/org-select/submit`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: `tereo_org_select_session_${testClient.clientId}=${sessionToken}`,
            },
            body: JSON.stringify({
              session_token: sessionToken,
              organization_id: org.id,
            }),
          });
        const results = await Promise.all(
          Array.from({ length: 5 }, () => submit())
        );

        expect(results.filter((r) => r.status === HTTP_STATUS.OK).length).toBe(
          1
        );
        expect(
          await prisma.consentSession.count({ where: { userId: user.id } })
        ).toBe(1);
      });
    });
  });

  describe("a password change during the org-select step", () => {
    let orgSelectControllers: typeof import("../../../../routes/oauth/org-select/controllers.js");

    beforeAll(async () => {
      orgSelectControllers =
        await import("../../../../routes/oauth/org-select/controllers.js");
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
      const req = {
        body,
        cookies,
        headers: {},
        ip: "127.0.0.1",
        method: "POST",
      };
      try {
        await handler(
          req as unknown as Request,
          res as unknown as ExpressResponse
        );
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
        await prisma.consentSession.count({
          where: { userId: session.user.id },
        })
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
});
