// @module-tag int
// @module-tag auth
// @module-tag race
import { NotFoundError, OAuth2Error } from "../../../../utils/errors.js";
import type { Request, Response as ExpressResponse } from "express";
import { createTestClient } from "../../../support/auth/clients.js";
import { createTestUser } from "../../../support/auth/users.js";
import { newPkce } from "../../../support/browserLogin.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import db from "../../../../utils/db/index.js";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
} from "../../../support/auth/crypto.js";
import {
  generateRandomString,
  hashPassword,
} from "../../../../utils/crypto.js";

describe("/oauth/consent", () => {
  describe("an expired consent session read twice at once", () => {
    it("is not found for both, and deleting it twice does not throw", async () => {
      const client = await createTestClient();
      const user = await createTestUser();
      const sessionToken = generateUniqueId();
      const session = await db.consent.createConsentSession({
        sessionToken,
        userId: user.id,
        clientId: client.id,
        redirectUri: client.redirectUris[0],
        scopes: ["openid"],
        state: null,
        codeChallenge: generateCodeChallenge(generateCodeVerifier()),
        codeChallengeMethod: "S256",
        nonce: null,
        authTime: new Date(),
        expiresAt: new Date(Date.now() - 1000),
      });

      const results = await Promise.allSettled([
        db.consent.getConsentDetails(sessionToken),
        db.consent.getConsentDetails(sessionToken),
      ]);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
          NotFoundError
        );
      }

      await db.consent.deleteConsentSession(session.id);
    });
  });
});

describe("/oauth/consent", () => {
  let consentControllers: typeof import("../../../../routes/oauth/consent/controllers.js");

  beforeAll(async () => {
    consentControllers =
      await import("../../../../routes/oauth/consent/controllers.js");
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
      expect(
        await prisma.userSession.count({ where: { userId: user.id } })
      ).toBe(0);
    });
  });
});
