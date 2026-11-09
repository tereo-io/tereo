// @module-tag int
// @module-tag auth
// @module-tag race
import { ensureDefaultOrganization } from "../../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { requestPasswordReset } from "../../../../utils/passwordReset.js";
import { holdLocks, waitForLockWait } from "../../../support/dbLocks.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { SYSTEM_USER_ID } from "../../../../definitions/index.js";
import { createTestUser } from "../../../support/auth/users.js";
import { BASE_URL } from "../../../support/auth/constants.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { waitFor } from "../../../support/webhooks.js";
import { randomBytes } from "node:crypto";
import env from "../../../../env.js";
import axios from "axios";
import {
  startNotificationDeliveryWorker,
  stopNotificationDeliveryWorker,
} from "../../../../jobs/notificationDelivery.js";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../../../jobs/notificationQueues.js";
import {
  startFakeSmtpServer,
  type FakeSmtpServer,
} from "../../../support/fakeSmtpServer.js";
import {
  cleanNotifications,
  createNotificationConnection,
} from "../../../support/notifications.js";

const request = (body: unknown) =>
  axios.post(`${BASE_URL}/v1/password-reset`, body, {
    validateStatus: () => true,
  });

const liveLinks = (userId: string) =>
  prisma.userLinkToken.count({
    where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
  });

const rand = () => randomBytes(5).toString("hex");

describe("password reset request", () => {
  const allowPrivateHosts = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;
  let smtp: FakeSmtpServer;

  const addConnection = () =>
    createNotificationConnection({
      isDefault: true,
      settings: {
        host: "127.0.0.1",
        port: smtp.port,
        security: "none",
        defaultFrom: { address: "billing@acme.com" },
        allowedSenders: ["@acme.com"],
      },
    });

  const mailsTo = (email: string) =>
    smtp.messages.filter((m) => m.rcpt.includes(email));
  const waitForMails = (email: string, count: number) =>
    waitFor(async () => mailsTo(email).length >= count, 10_000, 50);

  // The work runs after the 202, so absence is shown by watching the database
  // for a while rather than by one read.
  const expectNoLink = async (userId: string, ms = 1500) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      expect(await prisma.userLinkToken.count({ where: { userId } })).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const createdProviders: string[] = [];

  beforeAll(async () => {
    await ensureDefaultOrganization();
    env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = true;
    smtp = await startFakeSmtpServer();
    await startNotificationDeliveryWorker();
  });
  beforeEach(async () => {
    smtp.messages.length = 0;
    await cleanNotifications();
    await addConnection();
  });
  afterAll(async () => {
    await prisma.identityProviderDomain.deleteMany({
      where: { providerId: { in: createdProviders } },
    });
    await prisma.identityProvider.deleteMany({
      where: { id: { in: createdProviders } },
    });
    await stopNotificationDeliveryWorker();
    await getNotificationQueue("email")
      .obliterate({ force: true })
      .catch(() => {});
    await closeNotificationQueues();
    await cleanNotifications();
    await smtp.close();
    env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = allowPrivateHosts;
  });

  it("every request answers 202 with an empty body", async () => {
    const eligible = await createTestUser();
    const deactivated = await createTestUser({ isActive: false });
    const ssoDomain = `sso-${rand()}.test`;
    const ssoUser = await createTestUser({ email: `u@${ssoDomain}` });
    const provider = await prisma.identityProvider.create({
      data: {
        slug: `p-${rand()}`,
        displayName: "P",
        kind: "oidc",
        issuer: "https://idp.test",
        clientId: "c",
        clientSecret: "s",
        createdBy: SYSTEM_USER_ID,
      },
    });
    createdProviders.push(provider.id);
    const org = await prisma.organization.findFirstOrThrow();
    await prisma.identityProviderDomain.create({
      data: {
        providerId: provider.id,
        domain: ssoDomain,
        organizationId: org.id,
        ssoOnly: true,
        createdBy: SYSTEM_USER_ID,
      },
    });

    const unknown = `nobody-${rand()}@test.local`;
    const results = [];
    for (const email of [
      unknown,
      deactivated.email,
      ssoUser.email,
      eligible.email,
    ]) {
      const res = await request({ email });
      results.push([res.status, res.data]);
    }

    for (const r of results) expect(r).toEqual([202, ""]);
    await waitForMails(eligible.email, 1);
    expect(await liveLinks(eligible.id)).toBe(1);
    // The ineligible requests came first and do less work than the eligible one.
    expect(await liveLinks(deactivated.id)).toBe(0);
    expect(await liveLinks(ssoUser.id)).toBe(0);
    for (const other of [deactivated, ssoUser]) {
      expect(mailsTo(other.email)).toHaveLength(0);
    }
    expect(mailsTo(unknown)).toHaveLength(0);
  });

  it("no email connection: 202 and no link", async () => {
    await prisma.notificationConnection.deleteMany();
    const user = await createTestUser();

    const res = await request({ email: user.email });

    expect(res.status).toBe(202);
    expect(res.data).toBe("");
    await expectNoLink(user.id);
  });

  it("concurrent requests leave one live password link", async () => {
    const user = await createTestUser();

    const results = await Promise.all([
      request({ email: user.email }),
      request({ email: user.email }),
    ]);

    expect(results.map((r) => r.status)).toEqual([202, 202]);
    await waitForMails(user.email, 2);
    expect(await liveLinks(user.id)).toBe(1);
  });

  it.each([
    ["deactivated", { isActive: false }],
    ["given a new address", { email: `moved-${rand()}@test.local` }],
  ])(
    "a user %s while the request waits for the lock gets no link",
    async (_, change) => {
      const user = await createTestUser();
      const release = await holdLocks(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "auth"."users" WHERE "id" = ${user.id}::uuid FOR UPDATE`;
        await tx.user.update({ where: { id: user.id }, data: change });
      });
      const pending = requestPasswordReset({ email: user.email });
      try {
        await waitForLockWait(`%"auth"."users"%FOR UPDATE%`);
      } finally {
        await release();
      }
      await pending;

      expect(
        await prisma.userLinkToken.count({ where: { userId: user.id } })
      ).toBe(0);
      expect(mailsTo(user.email)).toHaveLength(0);
    }
  );

  it("client_id of a real client is in the link; an unknown one is dropped", async () => {
    const client = await createTestClient();
    const a = await createTestUser();
    const b = await createTestUser();

    expect(
      (await request({ email: a.email, client_id: client.clientId })).status
    ).toBe(202);
    expect(
      (await request({ email: b.email, client_id: "no-such-client" })).status
    ).toBe(202);

    await waitForMails(a.email, 1);
    await waitForMails(b.email, 1);
    const textFor = (email: string) => mailsTo(email)[0]?.parsed.text;
    expect(textFor(a.email)).toContain(`?client_id=${client.clientId}#token=`);
    expect(textFor(b.email)).toContain("/set-password#token=");
    expect(textFor(b.email)).not.toContain("client_id");
  });

  it("records the requester's address in the audit entry", async () => {
    const user = await createTestUser();
    await request({ email: user.email });
    await waitForMails(user.email, 1);

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { entityId: user.id },
      orderBy: { createdAt: "desc" },
    });
    expect(entry.metadata).toMatchObject({
      action: "password_reset_requested",
      ip: expect.any(String),
    });
  });

  it("status reports whether a connection exists", async () => {
    const url = `${BASE_URL}/v1/password-reset/status`;
    expect((await axios.get(url)).data).toEqual({ enabled: true });

    await prisma.notificationConnection.deleteMany();
    expect((await axios.get(url)).data).toEqual({ enabled: false });
  });
});
