// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../../../../utils/defaultOrganization.js";
import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestClient } from "../../../../../../support/auth/clients.js";
import { SYSTEM_USER_ID } from "../../../../../../../definitions/index.js";
import { createTestUser } from "../../../../../../support/auth/users.js";
import { BASE_URL } from "../../../../../../support/auth/constants.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { waitFor } from "../../../../../../support/webhooks.js";
import { fetchJson } from "../../../../../../support/http.js";
import env from "../../../../../../../env.js";
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
    const client = await createTestClient({
      grantTypes: ["client_credentials"],
    });
    const account = await prisma.user
      .findFirstOrThrow({
        where: { oauthClientId: client.id },
      })
      .catch(async () =>
        prisma.user.create({
          data: {
            email: `svc-${Date.now()}@test.local`,
            name: "Service",
            userType: "service_account",
          },
        })
      );
    const res = await send(account.id, writer);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("user_not_verifiable");
  });

  it("system user and deactivated user → 409 user_not_verifiable", async () => {
    const inactive = await createTestUser({
      emailVerified: false,
      isActive: false,
    });
    for (const id of [SYSTEM_USER_ID, inactive.id]) {
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
