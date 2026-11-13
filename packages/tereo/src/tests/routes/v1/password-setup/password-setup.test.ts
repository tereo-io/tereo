// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../utils/defaultOrganization.js";
import { BASE_URL, HTTP_STATUS } from "../../../support/auth/constants.js";
import { hashFlowToken, hashPassword } from "../../../../utils/crypto.js";
import { ensureTestOrganization } from "../../../support/principals.js";
import { createGuest, issue } from "../../../support/passwordSetup.js";
import { getRedisClient, redisKey } from "../../../../utils/redis.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { SYSTEM_USER_ID } from "../../../../definitions/index.js";
import { emittedEvents } from "../../../support/outboxLog.js";
import { hashKeyPart } from "../../../../utils/rateLimit.js";
import { normalizeEmail } from "../../../../utils/email.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import { fetchJson } from "../../../support/http.js";
import { randomBytes } from "node:crypto";
import axios from "axios";
import {
  getAccessTokenForUser,
  loginAndExchange,
  postForm,
} from "../../../support/auth/login.js";
import {
  createAdminUser,
  createTestUser,
} from "../../../support/auth/users.js";

const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPE = "openid offline_access";
const NEW_PASSWORD = "BrandNewPassword123!";

const post = (path: string, body: unknown, headers: object = {}) =>
  axios.post(`${BASE_URL}/v1/password-setup${path}`, body, {
    validateStatus: () => true,
    headers,
  });

const inspect = (token: string) => post("/inspect", { token });
const setPassword = (token: string, password = NEW_PASSWORD) =>
  post("", { token, password });

const insertToken = (
  userId: string,
  over: { usedAt?: Date; expiresAt?: Date } = {}
) => {
  const token = randomBytes(32).toString("base64url");
  return prisma.userLinkToken
    .create({
      data: {
        userId,
        purpose: "setup",
        tokenHash: hashFlowToken(token),
        createdBy: SYSTEM_USER_ID,
        expiresAt: over.expiresAt ?? new Date(Date.now() + 3_600_000),
        usedAt: over.usedAt,
      },
    })
    .then(() => token);
};

describe("password setup", () => {
  let client: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async () => {
    await ensureDefaultOrganization();
    client = await createTestClient({ redirectUris: [REDIRECT_URI] });
  });

  describe("POST /v1/password-setup/inspect", () => {
    it("returns email, name and the link's expiry without consuming", async () => {
      const guest = await createGuest();
      const token = await issue(guest.id);
      const { expiresAt } = await prisma.userLinkToken.findFirstOrThrow({
        where: { userId: guest.id },
      });

      for (let i = 0; i < 2; i++) {
        const res = await inspect(token);
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data).toEqual({
          email: guest.email,
          name: guest.name,
          expiresAt: expiresAt.toISOString(),
          purpose: "setup",
        });
      }
    });

    it("returns the purpose", async () => {
      const guest = await createGuest();
      expect((await inspect(await issue(guest.id))).data.purpose).toBe("setup");

      const user = await createTestUser();
      const res = await inspect(await issue(user.id, false, "reset"));
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data.purpose).toBe("reset");
    });
  });

  describe("POST /v1/password-setup", () => {
    it("sets the password, then the user signs in", async () => {
      const guest = await createGuest();
      const token = await issue(guest.id);

      const res = await setPassword(token);
      expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);

      const tokens = await loginAndExchange(
        client,
        { email: guest.email, plainPassword: NEW_PASSWORD },
        REDIRECT_URI,
        SCOPE
      );
      expect(tokens.access_token).toBeTruthy();

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: guest.id },
      });
      expect(after.passwordChangeRequired).toBe(false);
    });

    it("answers a used, expired or unknown token and an expired guest with the same 404", async () => {
      const guest = await createGuest();
      const used = await insertToken(guest.id, { usedAt: new Date() });
      const expired = await insertToken(guest.id, {
        expiresAt: new Date(Date.now() - 1000),
      });
      const unknown = randomBytes(32).toString("base64url");
      const lapsedGuest = await createGuest({
        expiresAt: new Date(Date.now() - 1000),
      });
      const lapsed = await insertToken(lapsedGuest.id);
      const inactive = await createTestUser({ isActive: false });
      const inactiveToken = await insertToken(inactive.id);

      const bodies = new Set<string>();
      for (const token of [used, expired, unknown, lapsed, inactiveToken]) {
        for (const send of [inspect, setPassword]) {
          const res = await send(token);
          expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
          bodies.add(JSON.stringify(res.data));
        }
      }
      expect(bodies.size).toBe(1);
    });

    it("ends other sessions on set", async () => {
      const guest = await createGuest();
      await prisma.user.update({
        where: { id: guest.id },
        // Without the flag, so the old password signs in without the
        // forced-change step.
        data: {
          passwordHash: (await createTestUser({ password: "OldPassword123!" }))
            .passwordHash,
          passwordChangeRequired: false,
        },
      });
      const before = await loginAndExchange(
        client,
        { email: guest.email, plainPassword: "OldPassword123!" },
        REDIRECT_URI,
        SCOPE
      );
      const token = await issue(guest.id);

      expect((await setPassword(token)).status).toBe(HTTP_STATUS.NO_CONTENT);

      const res = await postForm("/oauth/token", {
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: before.refresh_token,
      });
      expect(res.status).toBe(400);
    });

    it(
      "lets exactly one of two concurrent sets succeed",
      { tags: ["race"] },
      async () => {
        const guest = await createGuest();
        const token = await issue(guest.id);

        const results = await Promise.all([
          setPassword(token, "FirstPassword123!"),
          setPassword(token, "SecondPassword123!"),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([204, 404]);
      }
    );

    it("kills the old link when a new one is issued", async () => {
      const guest = await createGuest();
      const first = await issue(guest.id);
      const second = await issue(guest.id);

      expect((await inspect(first)).status).toBe(HTTP_STATUS.NOT_FOUND);
      expect((await inspect(second)).status).toBe(HTTP_STATUS.OK);
    });

    it("answers 404 and keeps the password when the user is deactivated after inspect", async () => {
      const guest = await createGuest();
      const token = await issue(guest.id);
      expect((await inspect(token)).status).toBe(HTTP_STATUS.OK);

      await prisma.user.update({
        where: { id: guest.id },
        data: { isActive: false },
      });

      expect((await setPassword(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: guest.id },
      });
      expect(after.passwordHash).toBeNull();
      expect(after.passwordChangeRequired).toBe(true);
    });

    it(
      "lets two concurrent issues both succeed, leaving one live token",
      { tags: ["race"] },
      async () => {
        const guest = await createGuest();

        await Promise.all([issue(guest.id), issue(guest.id)]);

        expect(
          await prisma.userLinkToken.count({
            where: { userId: guest.id, usedAt: null },
          })
        ).toBe(1);
      }
    );

    it("rejects a weak password with 400 and leaves the token usable", async () => {
      const guest = await createGuest();
      const token = await issue(guest.id);

      expect((await setPassword(token, "short")).status).toBe(
        HTTP_STATUS.BAD_REQUEST
      );
      expect((await setPassword(token)).status).toBe(HTTP_STATUS.NO_CONTENT);
    });

    it("limits bad attempts per IP", async () => {
      const ip = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
      const headers = { "X-Forwarded-For": ip };
      const bad = () =>
        post("", { token: "nope", password: NEW_PASSWORD }, headers);

      for (let i = 0; i < 10; i++) {
        expect((await bad()).status).toBe(HTTP_STATUS.NOT_FOUND);
      }
      expect((await bad()).status).toBe(429);
    });
  });

  describe("reset links", () => {
    const passwordSetAudits = async (userId: string) =>
      (
        await prisma.auditLogEntry.findMany({
          where: { entityId: userId, entityType: "User" },
        })
      )
        .map((e) => e.metadata as { action: string; via?: string })
        .filter((m) => m.action === "password_set_from_link");

    const emailVerifiedAudits = async (userId: string) =>
      (
        await prisma.auditLogEntry.findMany({
          where: { entityId: userId, entityType: "User" },
        })
      )
        .map((e) => e.metadata as { action: string; via?: string })
        .filter((m) => m.action === "email_verified");

    const eventsOf = async (userId: string, eventType: string) =>
      (await emittedEvents(userId, eventType)).map(
        (event) => event as typeof event & { data: { via: string } }
      );

    it("sets a regular user's password; a setup link still refuses one", async () => {
      const user = await createTestUser();
      const setup = await issue(user.id, false, "setup");
      expect((await setPassword(setup)).status).toBe(HTTP_STATUS.NOT_FOUND);
      expect((await inspect(setup)).status).toBe(HTTP_STATUS.NOT_FOUND);

      const reset = await issue(user.id, false, "reset");
      expect((await setPassword(reset)).status).toBe(HTTP_STATUS.NO_CONTENT);
      const tokens = await loginAndExchange(
        client,
        { email: user.email, plainPassword: NEW_PASSWORD },
        REDIRECT_URI,
        SCOPE
      );
      expect(tokens.access_token).toBeTruthy();
    });

    it("clears the account's login backoff", async () => {
      const user = await createTestUser();
      const backoffKey = redisKey(
        `rl:login:account:${hashKeyPart(normalizeEmail(user.email))}`
      );
      await getRedisClient().hset(backoffKey, {
        failures: 20,
        next: Date.now() + 15 * 60 * 1000,
      });

      const reset = await issue(user.id, false, "reset");
      expect((await setPassword(reset)).status).toBe(HTTP_STATUS.NO_CONTENT);

      expect(await getRedisClient().exists(backoffKey)).toBe(0);
      const tokens = await loginAndExchange(
        client,
        { email: user.email, plainPassword: NEW_PASSWORD },
        REDIRECT_URI,
        SCOPE
      );
      expect(tokens.access_token).toBeTruthy();
    });

    /** Puts the address's domain under an SSO-only provider; returns a cleanup. */
    const makeSsoOnly = async (domain: string, id: string) => {
      const provider = await prisma.identityProvider.create({
        data: {
          slug: `p-${id}`,
          displayName: "P",
          kind: "oidc",
          issuer: "https://idp.test",
          clientId: "c",
          clientSecret: "s",
          createdBy: SYSTEM_USER_ID,
        },
      });
      await prisma.identityProviderDomain.create({
        data: {
          providerId: provider.id,
          domain,
          organizationId: (await prisma.organization.findFirstOrThrow()).id,
          ssoOnly: true,
          createdBy: SYSTEM_USER_ID,
        },
      });
      return async () => {
        await prisma.identityProviderDomain.deleteMany({
          where: { providerId: provider.id },
        });
        await prisma.identityProvider.delete({ where: { id: provider.id } });
      };
    };

    it("is 404 once the user's domain became SSO-only", async () => {
      const id = randomBytes(5).toString("hex");
      const domain = `sso-${id}.test`;
      const user = await createTestUser({ email: `u-${id}@${domain}` });
      const token = await issue(user.id, false, "reset");
      expect((await inspect(token)).status).toBe(HTTP_STATUS.OK);

      const cleanup = await makeSsoOnly(domain, id);
      try {
        expect((await inspect(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
        expect((await setPassword(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
        const after = await prisma.user.findUniqueOrThrow({
          where: { id: user.id },
        });
        expect(after.passwordHash).toBe(user.passwordHash);
      } finally {
        await cleanup();
      }
    });

    it("refuses a guest's setup link once the domain became SSO-only", async () => {
      const id = randomBytes(5).toString("hex");
      const domain = `sso-${id}.test`;
      const guest = await createGuest();
      await prisma.user.update({
        where: { id: guest.id },
        data: { email: `g-${id}@${domain}` },
      });
      const token = await issue(guest.id);
      expect((await inspect(token)).status).toBe(HTTP_STATUS.OK);

      const cleanup = await makeSsoOnly(domain, id);
      try {
        expect((await inspect(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
        expect((await setPassword(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
        const after = await prisma.user.findUniqueOrThrow({
          where: { id: guest.id },
        });
        expect(after.passwordHash).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("is 404 for a user deactivated or expired after the link was issued", async () => {
      const deactivated = await createTestUser();
      const deactivatedToken = await issue(deactivated.id, false, "reset");
      await prisma.user.update({
        where: { id: deactivated.id },
        data: { isActive: false },
      });
      const lapsed = await createGuest();
      const lapsedToken = await issue(lapsed.id, false, "reset");
      await prisma.user.update({
        where: { id: lapsed.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      for (const token of [deactivatedToken, lapsedToken]) {
        expect((await inspect(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
        expect((await setPassword(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
      }
    });

    it("refuses a reset link for a service account", async () => {
      const user = await createTestUser();
      await prisma.user.update({
        where: { id: user.id },
        data: { userType: "service_account" },
      });
      const token = await issue(user.id, false, "reset");
      expect((await setPassword(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("marks the email verified on redeem", async () => {
      const user = await createTestUser({ emailVerified: false });
      const token = await issue(user.id, false, "reset");

      expect((await setPassword(token)).status).toBe(HTTP_STATUS.NO_CONTENT);

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.emailVerifiedAt).not.toBeNull();
      const audits = await emailVerifiedAudits(user.id);
      expect(audits).toHaveLength(1);
      expect(audits[0].via).toBe("password_link");
      const events = await eventsOf(user.id, "auth.user.email-verified");
      expect(events).toHaveLength(1);
      expect(events[0].data.via).toBe("password_link");
    });

    it("leaves an already verified email's timestamp alone", async () => {
      const user = await createTestUser();
      const token = await issue(user.id, false, "reset");

      expect((await setPassword(token)).status).toBe(HTTP_STATUS.NO_CONTENT);

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.emailVerifiedAt).toEqual(user.emailVerifiedAt);
      expect(await emailVerifiedAudits(user.id)).toHaveLength(0);
    });

    it("carries via on the password-set audit entry and event", async () => {
      const user = await createTestUser();
      const guest = await createGuest();

      expect(
        (await setPassword(await issue(user.id, false, "reset"))).status
      ).toBe(HTTP_STATUS.NO_CONTENT);
      expect(
        (await setPassword(await issue(guest.id, false, "setup"))).status
      ).toBe(HTTP_STATUS.NO_CONTENT);

      expect((await passwordSetAudits(user.id))[0].via).toBe("reset");
      expect((await passwordSetAudits(guest.id))[0].via).toBe("setup");
      for (const [id, via] of [
        [user.id, "reset"],
        [guest.id, "setup"],
      ] as const) {
        const events = await eventsOf(id, "auth.user.password-set");
        expect(events).toHaveLength(1);
        expect(events[0].data.via).toBe(via);
      }
    });
  });

  describe("when the account changes hands", () => {
    let adminToken: string;
    beforeAll(async () => {
      adminToken = await getAccessTokenForUser(await createAdminUser(), client);
    });

    const patchUser = (id: string, body: object) =>
      fetchJson("PATCH", `${BASE_URL}/v1/admin/users/${id}`, adminToken, body);

    it("does not verify the address from a setup link: the inviter holds the URL", async () => {
      const organizationId = await ensureTestOrganization("password-setup");
      const invited = await fetchJson(
        "POST",
        `${BASE_URL}/v1/admin/guests`,
        adminToken,
        {
          organizationId,
          email: `guest-${randomBytes(6).toString("hex")}@example.com`,
          expiresIn: 86_400,
          initialAccess: { type: "password_setup_link" },
        }
      );
      expect(invited.status).toBe(201);
      const guestId: string = invited.body.user.id;

      // The test stands in for the inviter, who was handed the URL.
      const token = new URL(invited.body.passwordSetupUrl).hash.replace(
        "#token=",
        ""
      );
      expect((await setPassword(token)).status).toBe(HTTP_STATUS.NO_CONTENT);

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: guestId },
      });
      expect(after.passwordSetByUser).toBe(true);
      expect(after.emailVerifiedAt).toBeNull();
      const verified = (
        await prisma.auditLogEntry.findMany({
          where: { entityId: guestId, entityType: "User" },
        })
      ).filter(
        (e) =>
          (e.metadata as { action?: string } | null)?.action ===
          "email_verified"
      );
      expect(verified).toHaveLength(0);
    });

    /** A guest with a password, a live link and a pending change grant. */
    const guestWithLinks = async () => {
      const guest = await createGuest();
      const plainPassword = "GuestPassword123!";
      await prisma.user.update({
        where: { id: guest.id },
        data: {
          passwordHash: await hashPassword(plainPassword),
          passwordChangeRequired: false,
        },
      });
      const token = await issue(guest.id);
      await prisma.passwordChangeGrant.create({
        data: {
          tokenHash: `grant-${guest.id}`,
          cookieSecretHash: `cookie-${guest.id}`,
          userId: guest.id,
          clientId: client.id,
          redirectUri: REDIRECT_URI,
          scopes: ["openid"],
          codeChallenge: "c",
          codeChallengeMethod: "S256",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      return { guest, token, plainPassword };
    };

    const expectRetired = async (userId: string, token: string) => {
      expect((await inspect(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
      expect(
        await prisma.userLinkToken.count({
          where: { userId, usedAt: null },
        })
      ).toBe(0);
      expect(
        await prisma.passwordChangeGrant.count({ where: { userId } })
      ).toBe(0);
    };

    it("refuses a live link once the user is no longer a guest", async () => {
      const guest = await createGuest();
      const token = await issue(guest.id);
      await prisma.user.update({
        where: { id: guest.id },
        data: { userType: "human", expiresAt: null },
      });

      expect((await inspect(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
      expect((await setPassword(token)).status).toBe(HTTP_STATUS.NOT_FOUND);
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: guest.id },
      });
      expect(after.passwordHash).toBeNull();
    });

    it("retires them on an admin password reset, which the user did not choose", async () => {
      const { guest, token } = await guestWithLinks();

      const res = await patchUser(guest.id, { password: "AdminChosen123!x" });

      expect(res.status).toBe(HTTP_STATUS.OK);
      await expectRetired(guest.id, token);
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: guest.id },
      });
      expect(after.passwordSetByUser).toBe(false);
    });

    it("retires them on an email change", async () => {
      const { guest, token } = await guestWithLinks();

      const res = await patchUser(guest.id, {
        email: `moved-${randomBytes(6).toString("hex")}@test.local`,
      });

      expect(res.status).toBe(HTTP_STATUS.OK);
      await expectRetired(guest.id, token);
    });

    it("retires them on deactivation, so a reactivation does not revive them", async () => {
      const { guest, token } = await guestWithLinks();

      expect((await patchUser(guest.id, { isActive: false })).status).toBe(
        HTTP_STATUS.OK
      );
      expect((await patchUser(guest.id, { isActive: true })).status).toBe(
        HTTP_STATUS.OK
      );

      await expectRetired(guest.id, token);
    });

    it("retires them when the user changes their own password", async () => {
      const { guest, token, plainPassword } = await guestWithLinks();
      await prisma.user.update({
        where: { id: guest.id },
        data: { passwordSetByUser: false },
      });
      const userToken = await getAccessTokenForUser(
        { id: guest.id, email: guest.email, plainPassword },
        client
      );

      const res = await fetchJson(
        "POST",
        `${BASE_URL}/v1/account/password`,
        userToken,
        { currentPassword: plainPassword, newPassword: "UsersOwnChoice123!" }
      );

      expect(res.status).toBe(HTTP_STATUS.OK);
      await expectRetired(guest.id, token);
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: guest.id },
      });
      expect(after.passwordSetByUser).toBe(true);
    });

    it("marks a password set from a link as the user's own", async () => {
      const guest = await createGuest();
      await prisma.user.update({
        where: { id: guest.id },
        data: { passwordSetByUser: false },
      });

      expect((await setPassword(await issue(guest.id))).status).toBe(
        HTTP_STATUS.NO_CONTENT
      );

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: guest.id },
      });
      expect(after.passwordSetByUser).toBe(true);
    });
  });
});
