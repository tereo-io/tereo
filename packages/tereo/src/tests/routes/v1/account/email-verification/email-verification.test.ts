// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestPrincipalToken } from "../../../../support/principals.js";
import { SYSTEM_USER_ID } from "../../../../../definitions/index.js";
import { createTestUser } from "../../../../support/auth/users.js";
import { BASE_URL } from "../../../../support/auth/constants.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { waitFor } from "../../../../support/webhooks.js";
import { fetchJson } from "../../../../support/http.js";
import { randomUUID } from "node:crypto";
import env from "../../../../../env.js";
import {
  startNotificationDeliveryWorker,
  stopNotificationDeliveryWorker,
} from "../../../../../jobs/notificationDelivery.js";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../../../../jobs/notificationQueues.js";
import {
  startFakeSmtpServer,
  type FakeSmtpServer,
} from "../../../../support/fakeSmtpServer.js";
import {
  cleanNotifications,
  createNotificationConnection,
} from "../../../../support/notifications.js";

const resend = async (userId: string) =>
  fetchJson(
    "POST",
    `${BASE_URL}/v1/account/email-verification`,
    await getTestPrincipalToken({ userId, permissions: [] })
  );

describe("POST /v1/account/email-verification", () => {
  const allowPrivateHosts = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;
  let smtp: FakeSmtpServer;

  beforeAll(async () => {
    await ensureDefaultOrganization();
    env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = true;
    smtp = await startFakeSmtpServer();
    // The server does not run the delivery worker under test.
    await startNotificationDeliveryWorker();
  });
  beforeEach(async () => {
    smtp.messages.length = 0;
    await cleanNotifications();
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

  const connect = () =>
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

  it("resend sends a link", async () => {
    await connect();
    const user = await createTestUser({ emailVerified: false });

    const res = await resend(user.id);
    expect(res.status).toBe(202);

    await waitFor(async () => smtp.messages.length === 1, 10_000, 50);
    const [message] = smtp.messages;
    expect(message.rcpt).toEqual([user.email]);
    expect(message.parsed.text).toContain("/verify-email#token=");
    expect(
      await prisma.userLinkToken.count({
        where: { userId: user.id, purpose: "verify", usedAt: null },
      })
    ).toBe(1);
  });

  it("already verified → 409 already_verified", async () => {
    await connect();
    const user = await createTestUser();

    const res = await resend(user.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_verified");
    expect(
      await prisma.userLinkToken.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("second resend within a minute → 429", async () => {
    await connect();
    const user = await createTestUser({ emailVerified: false });

    expect((await resend(user.id)).status).toBe(202);
    expect((await resend(user.id)).status).toBe(429);
  });

  it("a refusal does not cost a limiter slot", async () => {
    await connect();
    const user = await createTestUser({ emailVerified: false });
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });

    expect((await resend(user.id)).status).toBe(409);
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: null },
    });
    expect((await resend(user.id)).status).toBe(202);
  });

  it("no connection does not cost a limiter slot", async () => {
    const user = await createTestUser({ emailVerified: false });

    expect((await resend(user.id)).status).toBe(409);
    await connect();
    expect((await resend(user.id)).status).toBe(202);
  });

  it("service account and system user → 409 user_not_verifiable", async () => {
    await connect();
    const account = await prisma.user.create({
      data: {
        email: `svc-${randomUUID()}@test.local`,
        name: "Service",
        userType: "service_account",
      },
    });
    for (const id of [account.id, SYSTEM_USER_ID]) {
      const res = await resend(id);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("user_not_verifiable");
    }
  });

  it("no connection → 409 email_not_configured", async () => {
    const user = await createTestUser({ emailVerified: false });

    const res = await resend(user.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("email_not_configured");
  });
});
