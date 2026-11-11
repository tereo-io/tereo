// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { createGuest, issue } from "../../../../../support/passwordSetup.js";
import { issueVerifyLinkFor } from "../../../../../support/verifyLink.js";
import { createScimConnection } from "../../../../../support/scim.js";
import { BASE_URL } from "../../../../../support/auth/constants.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { waitFor } from "../../../../../support/webhooks.js";
import { fetchJson } from "../../../../../support/http.js";
import env from "../../../../../../env.js";
import { randomUUID } from "node:crypto";
import {
  startNotificationDeliveryWorker,
  stopNotificationDeliveryWorker,
} from "../../../../../../jobs/notificationDelivery.js";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../../../../../jobs/notificationQueues.js";
import {
  startFakeSmtpServer,
  type FakeSmtpServer,
} from "../../../../../support/fakeSmtpServer.js";
import {
  cleanNotifications,
  createNotificationConnection,
} from "../../../../../support/notifications.js";
import {
  createTestRole,
  createTestUser,
} from "../../../../../support/auth/users.js";
import {
  activeState,
  managedWith,
  tag,
} from "../../../../../support/scimUsers.js";

const patch = (id: string, token: string, body: unknown) =>
  fetchJson("PATCH", `${BASE_URL}/v1/admin/users/${id}`, token, body);

const liveLinks = (userId: string, purpose: "reset" | "verify" | "setup") =>
  prisma.userLinkToken.count({
    where: { userId, purpose, usedAt: null, expiresAt: { gt: new Date() } },
  });

describe("PATCH /v1/admin/users/:id and email verification", () => {
  const allowPrivateHosts = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;
  let smtp: FakeSmtpServer;
  let writer: string;

  beforeAll(async () => {
    await ensureDefaultOrganization();
    writer = await getTestPrincipalToken({
      permissions: ["users.write", "users.admin"],
    });
    env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = true;
    smtp = await startFakeSmtpServer();
    await startNotificationDeliveryWorker();
  });
  beforeEach(async () => {
    smtp.messages.length = 0;
    await cleanNotifications();
    await createNotificationConnection({
      isDefault: true,
      settings: {
        host: "127.0.0.1",
        port: smtp.port,
        security: "none",
        defaultFrom: { address: "billing@acme.com" },
        allowedSenders: ["@acme.com"],
      },
    });
  });
  afterAll(async () => {
    await stopNotificationDeliveryWorker();
    await getNotificationQueue("email")
      .obliterate({ force: true })
      .catch(() => {});
    await closeNotificationQueues();
    await cleanNotifications();
    await smtp.close();
    env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = allowPrivateHosts;
  });

  it("changing the email unverifies, retires links and sends a verify link", async () => {
    const user = await createTestUser();
    const reset = await issue(user.id, false, "reset");
    expect(reset).toBeTruthy();
    expect(await liveLinks(user.id, "reset")).toBe(1);
    const newEmail = `moved-${randomUUID()}@acme.com`;

    const res = await patch(user.id, writer, { email: newEmail });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(newEmail);
    expect(res.body.emailVerified).toBe(false);
    expect(await liveLinks(user.id, "reset")).toBe(0);
    const reply = await fetchJson(
      "POST",
      `${BASE_URL}/v1/password-setup/inspect`,
      null,
      { token: reset }
    );
    expect(reply.status).toBe(404);

    await waitFor(async () => smtp.messages.length === 1, 10_000, 50);
    expect(smtp.messages[0].rcpt).toEqual([newEmail]);
    expect(smtp.messages[0].parsed.text).toContain("/verify-email#token=");
    expect(await liveLinks(user.id, "verify")).toBe(1);
    const link = await prisma.userLinkToken.findFirstOrThrow({
      where: { userId: user.id, purpose: "verify", usedAt: null },
    });
    expect(link.email).toBe(newEmail);
  });

  it("changing the email without a connection still succeeds", async () => {
    await cleanNotifications();
    const user = await createTestUser();
    const newEmail = `moved-${randomUUID()}@acme.com`;

    const res = await patch(user.id, writer, { email: newEmail });

    expect(res.status).toBe(200);
    expect(res.body.emailVerified).toBe(false);
    expect(await liveLinks(user.id, "verify")).toBe(0);
    expect(smtp.messages).toHaveLength(0);
  });

  it("the same email in another case or with spaces is not a change", async () => {
    const user = await createTestUser({ emailVerified: false });
    await issueVerifyLinkFor(user.id);
    await waitFor(async () => smtp.messages.length === 1, 10_000, 50);
    smtp.messages.length = 0;
    // Verified with the link still live: a change would unverify and retire it.
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });
    await issue(user.id, false, "reset");
    const mailTo = () =>
      prisma.notification.count({
        where: { recipients: { path: ["0", "address"], equals: user.email } },
      });
    const sent = await mailTo();

    const res = await patch(user.id, writer, {
      email: `  ${user.email.toUpperCase()}  `,
    });

    expect(res.status).toBe(200);
    expect(res.body.emailVerified).toBe(true);
    expect(await liveLinks(user.id, "verify")).toBe(1);
    expect(await liveLinks(user.id, "reset")).toBe(1);
    expect(await mailTo()).toBe(sent);
  });

  it("a password-only change keeps the verify link", async () => {
    const user = await createTestUser({ emailVerified: false });
    await issueVerifyLinkFor(user.id);
    await issue(user.id, false, "reset");

    const res = await patch(user.id, writer, {
      password: "N3w-Str0ng-Passw0rd!",
    });

    expect(res.status).toBe(200);
    expect(await liveLinks(user.id, "verify")).toBe(1);
    expect(await liveLinks(user.id, "reset")).toBe(0);
  });

  it("deactivating retires verify links", async () => {
    const user = await createTestUser({ emailVerified: false });
    await issueVerifyLinkFor(user.id);
    expect(await liveLinks(user.id, "verify")).toBe(1);

    const res = await patch(user.id, writer, { isActive: false });

    expect(res.status).toBe(200);
    expect(await liveLinks(user.id, "verify")).toBe(0);
  });

  it("deactivating and changing the email together leaves no verify link or mail", async () => {
    const user = await createTestUser();
    const newEmail = `moved-${randomUUID()}@acme.com`;

    const res = await patch(user.id, writer, {
      email: newEmail,
      isActive: false,
    });

    expect(res.status).toBe(200);
    expect(res.body.emailVerified).toBe(false);
    expect(await liveLinks(user.id, "verify")).toBe(0);
    expect(
      await prisma.notification.count({
        where: { recipients: { path: ["0", "address"], equals: newEmail } },
      })
    ).toBe(0);
  });

  it("changing an expired guest's email sends no verify link", async () => {
    const guest = await createGuest({ expiresAt: new Date(Date.now() - 1000) });
    const newEmail = `moved-${randomUUID()}@acme.com`;

    const res = await patch(guest.id, writer, { email: newEmail });

    expect(res.status).toBe(200);
    expect(res.body.emailVerified).toBe(false);
    expect(await liveLinks(guest.id, "verify")).toBe(0);
    expect(
      await prisma.notification.count({
        where: { recipients: { path: ["0", "address"], equals: newEmail } },
      })
    ).toBe(0);
  });

  it("a password and an email change together unverify, retire links and send a verify link", async () => {
    const user = await createTestUser();
    await issue(user.id, false, "reset");
    const newEmail = `moved-${randomUUID()}@acme.com`;

    const res = await patch(user.id, writer, {
      email: newEmail,
      password: "N3w-Str0ng-Passw0rd!",
    });

    expect(res.status).toBe(200);
    expect(res.body.emailVerified).toBe(false);
    expect(await liveLinks(user.id, "reset")).toBe(0);
    await waitFor(async () => smtp.messages.length === 1, 10_000, 50);
    expect(smtp.messages[0].rcpt).toEqual([newEmail]);
    expect(await liveLinks(user.id, "verify")).toBe(1);
  });

  it.each([
    ["email", { email: `moved-${randomUUID()}@acme.com` }],
    ["password", { password: "N3w-Str0ng-Passw0rd!" }],
  ])(
    "a %s change of a user who is admin only through a group is refused and changes nothing",
    async (_, body) => {
      const target = await createTestUser();
      const role = await createTestRole();
      const { id: permissionId } = await prisma.permission.findUniqueOrThrow({
        where: { name: "admin" },
      });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId },
      });
      const group = await prisma.group.create({
        data: {
          slug: `patch-${randomUUID()}`,
          name: "Admins",
          definitionSource: "local",
          createdBy: target.id,
        },
      });
      try {
        await prisma.groupMember.create({
          data: { groupId: group.id, userId: target.id, addedBy: target.id },
        });
        await prisma.groupRole.create({
          data: { groupId: group.id, roleId: role.id, addedBy: target.id },
        });
        await issue(target.id, false, "reset");

        const res = await patch(target.id, writer, body);

        expect(res.status).toBe(403);
        expect(JSON.stringify(res.body)).toContain(
          "holding permissions you do not: admin"
        );
        const after = await prisma.user.findUniqueOrThrow({
          where: { id: target.id },
        });
        expect(after.email).toBe(target.email);
        expect(after.emailVerifiedAt).not.toBeNull();
        expect(await liveLinks(target.id, "reset")).toBe(1);
        expect(await liveLinks(target.id, "verify")).toBe(0);
      } finally {
        await prisma.groupRole.deleteMany({ where: { groupId: group.id } });
        await prisma.groupMember.deleteMany({ where: { groupId: group.id } });
        await prisma.group.delete({ where: { id: group.id } });
      }
    }
  );
});

describe("PATCH /v1/admin/users/:id on a SCIM-managed user", () => {
  let writer: string;

  beforeAll(async () => {
    writer = await getTestPrincipalToken({
      permissions: ["users.read", "users.write"],
    });
  });

  const scimUser = async (
    link: { idpActive?: boolean; adminHold?: boolean; deletedAt?: Date } = {}
  ) => {
    const c = await createScimConnection();
    const { id } = await managedWith(c, link);
    return await prisma.user.update({
      where: { id },
      data: { firstName: "Jane", lastName: "Doe" },
    });
  };

  const expectManaged = (r: { status: number; body: unknown }) => {
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "managed_by_scim" });
  };

  it.each([
    ["name", { name: "Someone Else" }],
    ["email", { email: `moved-${tag()}@elsewhere.test` }],
  ])("refuses a change to %s with 409 managed_by_scim", async (_, body) => {
    const user = await scimUser();
    expectManaged(await patch(user.id, writer, body));
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    ).toEqual(user);
  });

  it("refuses a profile change while the link is deleted", async () => {
    const user = await scimUser({ idpActive: false, deletedAt: new Date() });
    expectManaged(await patch(user.id, writer, { name: "Taken Back" }));
  });

  it("accepts a body repeating the current profile", async () => {
    const user = await scimUser();
    const r = await patch(user.id, writer, {
      name: user.name,
      email: user.email,
    });
    expect(r.status).toBe(200);
  });

  it("deactivates and sets the admin hold", async () => {
    const user = await scimUser();
    const r = await patch(user.id, writer, { isActive: false });
    expect(r.status).toBe(200);
    expect(r.body.isActive).toBe(false);
    expect(await activeState(user.id)).toEqual({
      isActive: false,
      idpActive: true,
      adminHold: true,
    });
  });

  it.each([
    ["without a hold", { idpActive: false }],
    ["under a hold", { idpActive: false, adminHold: true }],
  ])(
    "refuses a reactivation while the IdP has the user inactive (%s)",
    async (_, link) => {
      const user = await scimUser(link);
      const before = await activeState(user.id);
      expectManaged(await patch(user.id, writer, { isActive: true }));
      expect(await activeState(user.id)).toEqual(before);
    }
  );

  it("reactivates a held user the IdP has active and clears the hold", async () => {
    const user = await scimUser({ adminHold: true });
    const r = await patch(user.id, writer, { isActive: true });
    expect(r.status).toBe(200);
    expect(r.body.isActive).toBe(true);
    expect(await activeState(user.id)).toEqual({
      isActive: true,
      idpActive: true,
      adminHold: false,
    });
  });

  it("changes the rate limit and the password", async () => {
    const user = await scimUser();
    const limited = await patch(user.id, writer, { rateLimitPerSecond: 7 });
    expect(limited.status).toBe(200);
    expect(limited.body.rateLimitPerSecond).toBe(7);
    const reset = await patch(user.id, writer, {
      password: "Another-Passw0rd!",
    });
    expect(reset.status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.passwordHash).not.toBeNull();
  });
});
