// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { issueVerifyLinkFor } from "../../../../../support/verifyLink.js";
import { createTestUser } from "../../../../../support/auth/users.js";
import { BASE_URL } from "../../../../../support/auth/constants.js";
import { issue } from "../../../../../support/passwordSetup.js";
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
    const user = await createTestUser();
    await issueVerifyLinkFor(user.id);
    await waitFor(async () => smtp.messages.length === 1, 10_000, 50);
    smtp.messages.length = 0;
    await issue(user.id, false, "reset");

    const res = await patch(user.id, writer, {
      email: `  ${user.email.toUpperCase()}  `,
    });

    expect(res.status).toBe(200);
    expect(res.body.emailVerified).toBe(true);
    expect(await liveLinks(user.id, "verify")).toBe(1);
    expect(await liveLinks(user.id, "reset")).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(smtp.messages).toHaveLength(0);
  });

  it("a password-only change keeps the verify link", async () => {
    const user = await createTestUser();
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
});
