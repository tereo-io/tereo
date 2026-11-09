// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../../../../utils/defaultOrganization.js";
import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { SYSTEM_USER_ID } from "../../../../../../../definitions/index.js";
import { createTestUser } from "../../../../../../support/auth/users.js";
import { createGuest } from "../../../../../../support/passwordSetup.js";
import { BASE_URL } from "../../../../../../support/auth/constants.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { waitFor } from "../../../../../../support/webhooks.js";
import { fetchJson } from "../../../../../../support/http.js";
import env from "../../../../../../../env.js";
import { randomUUID } from "node:crypto";
import {
  startNotificationDeliveryWorker,
  stopNotificationDeliveryWorker,
} from "../../../../../../../jobs/notificationDelivery.js";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../../../../../../jobs/notificationQueues.js";
import {
  startFakeSmtpServer,
  type FakeSmtpServer,
} from "../../../../../../support/fakeSmtpServer.js";
import {
  cleanNotifications,
  createNotificationConnection,
} from "../../../../../../support/notifications.js";

const send = (id: string, token: string) =>
  fetchJson(
    "POST",
    `${BASE_URL}/v1/admin/users/${id}/email-verification`,
    token
  );

describe("POST /v1/admin/users/:id/email-verification", () => {
  const allowPrivateHosts = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;
  let smtp: FakeSmtpServer;
  let writer: string;

  beforeAll(async () => {
    await ensureDefaultOrganization();
    writer = await getTestPrincipalToken({ permissions: ["users.write"] });
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

  it("users.write sends; response has no url", async () => {
    const user = await createTestUser({ emailVerified: false });

    const res = await send(user.id, writer);
    expect(res.status).toBe(202);
    expect(res.body).toBeNull();

    await waitFor(async () => smtp.messages.length === 1, 10_000, 50);
    expect(smtp.messages[0].rcpt).toEqual([user.email]);
    expect(smtp.messages[0].parsed.text).toContain("/verify-email#token=");
  });

  it("the sixth send for one user in an hour → 429; a refusal costs nothing", async () => {
    const user = await createTestUser();
    expect((await send(user.id, writer)).status).toBe(409);
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: null },
    });

    for (let i = 0; i < 5; i++) {
      expect((await send(user.id, writer)).status).toBe(202);
    }
    const over = await send(user.id, writer);
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("too_many_requests");

    const other = await createTestUser({ emailVerified: false });
    expect((await send(other.id, writer)).status).toBe(202);
  });

  it("already verified → 409 already_verified", async () => {
    const user = await createTestUser();
    const res = await send(user.id, writer);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_verified");
  });

  it("no connection → 409 email_not_configured", async () => {
    await cleanNotifications();
    const user = await createTestUser({ emailVerified: false });
    const res = await send(user.id, writer);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("email_not_configured");
  });

  it("service account → 409 user_not_verifiable", async () => {
    const account = await prisma.user.create({
      data: {
        email: `svc-${randomUUID()}@test.local`,
        name: "Service",
        userType: "service_account",
      },
    });
    const res = await send(account.id, writer);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("user_not_verifiable");
  });

  it("system user, deactivated user and expired guest → 409 user_not_verifiable", async () => {
    const inactive = await createTestUser({
      emailVerified: false,
      isActive: false,
    });
    const expired = await createGuest({
      expiresAt: new Date(Date.now() - 1000),
    });
    for (const id of [SYSTEM_USER_ID, inactive.id, expired.id]) {
      const res = await send(id, writer);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("user_not_verifiable");
    }
  });

  it("unknown user → 404", async () => {
    expect((await send(crypto.randomUUID(), writer)).status).toBe(404);
  });

  it("without users.write → 403", async () => {
    const reader = await getTestPrincipalToken({ permissions: ["users.read"] });
    const user = await createTestUser({ emailVerified: false });
    expect((await send(user.id, reader)).status).toBe(403);
    expect(
      await prisma.userLinkToken.count({ where: { userId: user.id } })
    ).toBe(0);
  });
});
