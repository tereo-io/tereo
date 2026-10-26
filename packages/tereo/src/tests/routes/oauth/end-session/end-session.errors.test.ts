// @module-tag int
// @module-tag auth
// @module-tag security
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { currentSigningKey } from "../../../../utils/keys.js";
import { hashPassword } from "../../../../utils/crypto.js";
import { prisma } from "../../../../utils/db/prisma.js";
import env from "../../../../env.js";
import jwt from "jsonwebtoken";
import {
  BASE_URL,
  HTTP_STATUS,
  OAUTH_ERRORS,
} from "../../../support/auth/constants.js";
import {
  ID_TOKEN_HINT_GRACE_SECONDS,
  generateIdToken,
  generateAccessToken,
} from "../../../../utils/tokens.js";

// Test entity variables
let TEST_CLIENT_ID = "";
let TEST_CLIENT_DB_ID = "";
let TEST_USER_ID = "";
let TEST_USER_EMAIL = "";
const TEST_USER_PASSWORD = "TestPassword123!";
const TEST_REDIRECT_URI = "http://localhost:3000/test-callback";
const TEST_POST_LOGOUT_URI = "http://localhost:3000/test-logout";

interface EndSessionResponse {
  success?: boolean;
  error?: string;
  error_description?: string;
}

describe("/oauth/end-session and /oauth/end-session/confirm", () => {
  describe("OIDC Compliance", () => {
    beforeAll(async () => {
      // Check server is running
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      if (!response.ok) {
        throw new Error(`Server not running at ${BASE_URL}`);
      }

      // Create test entities
      const uniqueId = randomBytes(8).toString("hex");
      TEST_CLIENT_ID = `test-oidc-client-${uniqueId}`;
      TEST_USER_EMAIL = `test-oidc-user-${uniqueId}@test.local`;

      // Create test owner user
      const ownerPasswordHash = await hashPassword("TestPassword123!");
      const testOwner = await prisma.user.create({
        data: {
          email: `test-oidc-owner-${uniqueId}@test.local`,
          passwordHash: ownerPasswordHash,
          name: "OIDC Test Owner",
          isActive: true,
        },
      });

      const client = await prisma.oAuthClient.create({
        data: {
          clientId: TEST_CLIENT_ID,
          clientSecret: null,
          clientType: "public",
          name: `OIDC Test Client ${uniqueId}`,
          redirectUris: [TEST_REDIRECT_URI],
          postLogoutRedirectUris: [TEST_POST_LOGOUT_URI],
          scopes: ["openid", "profile", "email", "offline_access"],
          grantTypes: ["authorization_code", "refresh_token"],
          audience: [],
          ownerId: testOwner.id,
        },
      });
      TEST_CLIENT_DB_ID = client.id;

      const passwordHash = await hashPassword(TEST_USER_PASSWORD);
      const user = await prisma.user.create({
        data: {
          email: TEST_USER_EMAIL,
          passwordHash,
          name: "OIDC Test User",
          isActive: true,
        },
      });
      TEST_USER_ID = user.id;
    });

    afterAll(async () => {
      // Cleanup test entities
      if (TEST_USER_ID) {
        await prisma.userSession.deleteMany({
          where: { userId: TEST_USER_ID },
        });
        await prisma.consentSession.deleteMany({
          where: { userId: TEST_USER_ID, clientId: TEST_CLIENT_DB_ID },
        });
        await prisma.user
          .delete({ where: { id: TEST_USER_ID } })
          .catch(() => {});
      }
      if (TEST_CLIENT_DB_ID) {
        await prisma.oAuthClient
          .delete({ where: { id: TEST_CLIENT_DB_ID } })
          .catch(() => {});
      }
    });

    describe("End Session - id_token_hint verification and redirect", () => {
      let victimId = "";

      // Posted as the admin UI does, which gets JSON rather than a redirect.
      const endSession = (query: Record<string, string>) =>
        fetch(`${BASE_URL}/oauth/end-session`, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(query),
        });

      /** An SSO session with a token family issued under it; returns its id. */
      const giveVictimASession = async () => {
        const session = await prisma.userSession.create({
          data: {
            tokenHash: randomBytes(32).toString("hex"),
            userId: victimId,
            authTime: new Date(),
            expiresAt: new Date(Date.now() + 3600_000),
          },
        });
        const code = await prisma.authorizationCode.create({
          data: {
            codeHash: randomBytes(32).toString("hex"),
            clientId: TEST_CLIENT_DB_ID,
            userId: victimId,
            redirectUri: TEST_REDIRECT_URI,
            scopes: ["openid"],
            codeChallenge: "challenge",
            codeChallengeMethod: "S256",
            authTime: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: new Date(),
            userSessionId: session.id,
          },
        });
        await prisma.refreshToken.create({
          data: {
            tokenHash: randomBytes(32).toString("hex"),
            clientId: TEST_CLIENT_DB_ID,
            userId: victimId,
            authCodeId: code.id,
            scopes: ["openid"],
            expiresAt: new Date(Date.now() + 3600_000),
          },
        });
        return session.id;
      };

      const victimState = async () => ({
        sessions: await prisma.userSession.count({
          where: { userId: victimId },
        }),
        liveRefreshTokens: await prisma.refreshToken.count({
          where: { userId: victimId, revokedAt: null },
        }),
      });

      const expectRejected = async (
        response: Response,
        description?: string
      ) => {
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        const data = (await response.json()) as EndSessionResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
        if (description) expect(data.error_description).toBe(description);
      };

      beforeAll(async () => {
        const victim = await prisma.user.create({
          data: {
            email: `test-oidc-victim-${randomBytes(8).toString("hex")}@test.local`,
            passwordHash: await hashPassword(TEST_USER_PASSWORD),
            name: "OIDC Logout Victim",
            isActive: true,
          },
        });
        victimId = victim.id;
      });

      afterAll(async () => {
        await prisma.refreshToken.deleteMany({ where: { userId: victimId } });
        await prisma.authorizationCode.deleteMany({
          where: { userId: victimId },
        });
        await prisma.userSession.deleteMany({ where: { userId: victimId } });
        await prisma.user.delete({ where: { id: victimId } }).catch(() => {});
      });

      it("rejects a hint signed with another key and leaves the victim signed in", async () => {
        await giveVictimASession();
        const before = await victimState();
        const { privateKey } = generateKeyPairSync("rsa", {
          modulusLength: 2048,
        });
        const forged = jwt.sign(
          {
            iss: env.ISSUER,
            sub: victimId,
            aud: TEST_CLIENT_ID,
          },
          privateKey,
          // Core's kid, so it is the signature that fails.
          { algorithm: "RS256", expiresIn: 300, keyid: currentSigningKey().kid }
        );

        await expectRejected(
          await endSession({ id_token_hint: forged }),
          "Invalid id_token_hint"
        );
        expect(await victimState()).toEqual(before);
        expect(before.sessions).toBeGreaterThan(0);
      });

      it("rejects an unsigned hint", async () => {
        await giveVictimASession();
        const before = await victimState();
        const part = (value: object) =>
          Buffer.from(JSON.stringify(value)).toString("base64url");
        const unsigned = `${part({ alg: "none", typ: "JWT" })}.${part({
          iss: env.ISSUER,
          sub: victimId,
          aud: TEST_CLIENT_ID,
        })}.`;

        await expectRejected(await endSession({ id_token_hint: unsigned }));
        expect(await victimState()).toEqual(before);
      });

      it("rejects a hint from another issuer", async () => {
        const { token } = generateIdToken({
          subject: victimId,
          clientId: TEST_CLIENT_ID,
        });
        const payload = jwt.decode(token) as Record<string, unknown>;
        const otherIssuer = jwt.sign(
          { ...payload, iss: "https://elsewhere.example" },
          currentSigningKey().privateKey,
          { algorithm: "RS256", keyid: currentSigningKey().kid }
        );

        await expectRejected(await endSession({ id_token_hint: otherIssuer }));
      });

      it("rejects an access token as the hint", async () => {
        const { token } = generateAccessToken({
          subject: victimId,
          clientId: TEST_CLIENT_ID,
          scopes: ["openid"],
          audience: [TEST_CLIENT_ID],
        });

        await expectRejected(await endSession({ id_token_hint: token }));
      });

      it("rejects a hint whose audience is not a known client", async () => {
        const { token } = generateIdToken({
          subject: victimId,
          clientId: "no-such-client",
        });

        await expectRejected(
          await endSession({ id_token_hint: token }),
          "Invalid id_token_hint: unknown audience"
        );
      });

      it("rejects a client_id that differs from the hint's audience", async () => {
        const { token } = generateIdToken({
          subject: victimId,
          clientId: TEST_CLIENT_ID,
        });

        await expectRejected(
          await endSession({ id_token_hint: token, client_id: "other-client" }),
          "client_id does not match the id_token_hint audience"
        );
      });

      it("ends the hint's session (sid) for a real id token, even one expired within the grace period", async () => {
        for (const expiresIn of [300, -300]) {
          const sessionId = await giveVictimASession();
          await giveVictimASession(); // another browser, which must survive
          const before = await victimState();
          const { token } = generateIdToken({
            subject: victimId,
            clientId: TEST_CLIENT_ID,
            sessionId,
            expiresIn,
          });

          const response = await endSession({ id_token_hint: token });
          expect(response.status).toBe(HTTP_STATUS.OK);
          expect(await victimState()).toEqual({
            sessions: before.sessions - 1,
            liveRefreshTokens: before.liveRefreshTokens - 1,
          });
          expect(
            await prisma.userSession.count({ where: { id: sessionId } })
          ).toBe(0);
        }
      });

      it("asks to confirm for a hint expired past the grace period", async () => {
        const sessionId = await giveVictimASession();
        const before = await victimState();
        const { token } = generateIdToken({
          subject: victimId,
          clientId: TEST_CLIENT_ID,
          sessionId,
          expiresIn: -(ID_TOKEN_HINT_GRACE_SECONDS + 60),
        });

        const response = await endSession({ id_token_hint: token });
        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const page = new URL(response.headers.get("location") ?? "");
        expect(page.pathname).toMatch(/\/logout$/);
        expect(page.searchParams.get("client_id")).toBe(TEST_CLIENT_ID);
        expect(await victimState()).toEqual(before);
      });

      it("redirects a navigation with a hint and no post_logout_redirect_uri to the client's sign-in", async () => {
        const sessionId = await giveVictimASession();
        const before = await victimState();
        const { token } = generateIdToken({
          subject: victimId,
          clientId: TEST_CLIENT_ID,
          sessionId,
        });

        const response = await fetch(
          `${BASE_URL}/oauth/end-session?${new URLSearchParams({ id_token_hint: token })}`,
          { redirect: "manual" }
        );
        expect(response.status).toBe(HTTP_STATUS.FOUND);
        expect(response.headers.get("location")).toBe(
          `${new URL(TEST_REDIRECT_URI).origin}/`
        );
        expect((await victimState()).sessions).toBe(before.sessions - 1);
      });

      it("ends nothing for a hint without sid and no cookies", async () => {
        await giveVictimASession();
        const before = await victimState();
        const { token } = generateIdToken({
          subject: victimId,
          clientId: TEST_CLIENT_ID,
        });

        const response = await endSession({ id_token_hint: token });
        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(await victimState()).toEqual(before);
      });

      it("ignores a sid that belongs to another user", async () => {
        await giveVictimASession();
        const before = await victimState();
        const otherSession = await prisma.userSession.create({
          data: {
            tokenHash: randomBytes(32).toString("hex"),
            userId: TEST_USER_ID,
            authTime: new Date(),
            expiresAt: new Date(Date.now() + 3600_000),
          },
        });
        const { token } = generateIdToken({
          subject: victimId,
          clientId: TEST_CLIENT_ID,
          sessionId: otherSession.id,
        });

        const response = await endSession({ id_token_hint: token });
        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(await victimState()).toEqual(before);
        expect(
          await prisma.userSession.count({ where: { id: otherSession.id } })
        ).toBe(1);
      });

      it("redirects with state for a real id token and a registered uri", async () => {
        const { token } = generateIdToken({
          subject: victimId,
          clientId: TEST_CLIENT_ID,
        });

        const response = await endSession({
          id_token_hint: token,
          post_logout_redirect_uri: TEST_POST_LOGOUT_URI,
          state: "hint-state",
        });
        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = new URL(response.headers.get("location") || "");
        expect(`${location.origin}${location.pathname}`).toBe(
          TEST_POST_LOGOUT_URI
        );
        expect(location.searchParams.get("state")).toBe("hint-state");
      });

      it("refuses a redirect when no client is identified", async () => {
        await expectRejected(
          await endSession({ post_logout_redirect_uri: "https://evil.com/cb" }),
          "post_logout_redirect_uri requires client_id or id_token_hint"
        );
      });

      it("refuses a redirect for an unknown client_id", async () => {
        await expectRejected(
          await endSession({
            client_id: "no-such-client",
            post_logout_redirect_uri: TEST_POST_LOGOUT_URI,
          }),
          "Invalid client_id"
        );
      });

      it("refuses an unregistered redirect uri with its own message", async () => {
        await expectRejected(
          await endSession({
            client_id: TEST_CLIENT_ID,
            post_logout_redirect_uri: `${TEST_POST_LOGOUT_URI}/other`,
          }),
          "post_logout_redirect_uri is not registered for this client"
        );
      });
    });
  });
});
