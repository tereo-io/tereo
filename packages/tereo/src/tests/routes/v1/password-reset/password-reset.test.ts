// @module-tag int
// @module-tag auth
// @module-tag race
import { ensureDefaultOrganization } from "../../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
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

  const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

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

    const results = [];
    for (const email of [
      eligible.email,
      `nobody-${rand()}@test.local`,
      deactivated.email,
      ssoUser.email,
    ]) {
      const res = await request({ email });
      results.push([res.status, res.data]);
    }

    for (const r of results) expect(r).toEqual([202, ""]);
    await waitFor(async () => smtp.messages.length >= 1, 10_000, 50);
    await settle();
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0].rcpt).toEqual([eligible.email]);
    expect(await liveLinks(deactivated.id)).toBe(0);
    expect(await liveLinks(ssoUser.id)).toBe(0);
  });

  it("no email connection: 202 and no link", async () => {
    await prisma.notificationConnection.deleteMany();
    const user = await createTestUser();

    const res = await request({ email: user.email });

    expect(res.status).toBe(202);
    expect(res.data).toBe("");
    expect(
      await prisma.userLinkToken.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("the fourth request in an hour for one address sends nothing", async () => {
    const user = await createTestUser();
    const upper = user.email.replace(/^[a-z]/, (c) => c.toUpperCase());

    const statuses = [];
    for (const email of [user.email, upper, user.email, upper]) {
      statuses.push((await request({ email })).status);
    }

    expect(statuses).toEqual([202, 202, 202, 202]);
    await waitFor(async () => smtp.messages.length >= 3, 10_000, 50);
    await settle();
    expect(smtp.messages).toHaveLength(3);
  });

  it("concurrent requests leave one live password link", async () => {
    const user = await createTestUser();

    const results = await Promise.all([
      request({ email: user.email }),
      request({ email: user.email }),
    ]);

    expect(results.map((r) => r.status)).toEqual([202, 202]);
    expect(await liveLinks(user.id)).toBe(1);
  });

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

    await waitFor(async () => smtp.messages.length >= 2, 10_000, 50);
    const textFor = (email: string) =>
      smtp.messages.find((m) => m.rcpt.includes(email))?.parsed.text;
    expect(textFor(a.email)).toContain(`?client_id=${client.clientId}#token=`);
    expect(textFor(b.email)).toContain("/set-password#token=");
    expect(textFor(b.email)).not.toContain("client_id");
  });

  it("records the requester's address in the audit entry", async () => {
    const user = await createTestUser();
    await request({ email: user.email });

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
