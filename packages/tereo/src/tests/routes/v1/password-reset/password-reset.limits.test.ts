// @module-tag int
// @module-tag auth
// @module-tag security
import { ensureDefaultOrganization } from "../../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestUser } from "../../../support/auth/users.js";
import { BASE_URL } from "../../../support/auth/constants.js";
import { waitFor } from "../../../support/webhooks.js";
import { randomInt } from "node:crypto";
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

// The default TRUST_PROXY (loopback) honours X-Forwarded-For.
const request = (email: string, ip: string) =>
  axios.post(
    `${BASE_URL}/v1/password-reset`,
    { email },
    { headers: { "X-Forwarded-For": ip }, validateStatus: () => true }
  );

const freshIp = () =>
  `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

describe("POST /v1/password-reset limits", () => {
  const allowPrivateHosts = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;
  let smtp: FakeSmtpServer;

  const mailsTo = (email: string) =>
    smtp.messages.filter((m) => m.rcpt.includes(email));
  const waitForMails = (email: string, count: number) =>
    waitFor(async () => mailsTo(email).length >= count, 10_000, 50);

  // A refused request starts no work, but the accepted ones before it send
  // after the 202: a later address's mail arriving from a fresh IP shows
  // their work is done.
  const settle = async () => {
    const later = await createTestUser();
    expect((await request(later.email, freshIp())).status).toBe(202);
    await waitForMails(later.email, 1);
  };

  const send = async (email: string, ip: string, times: number) => {
    for (let i = 0; i < times; i++) {
      const res = await request(email, ip);
      expect([res.status, res.data]).toEqual([202, ""]);
    }
  };

  beforeAll(async () => {
    await ensureDefaultOrganization();
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

  it("one IP's eleventh request in an hour, for any address, answers 202 and sends nothing", async () => {
    const ip = freshIp();
    const users = [];
    for (let i = 0; i < 11; i++) users.push(await createTestUser());

    for (const user of users) await send(user.email, ip, 1);

    for (const user of users.slice(0, 10)) await waitForMails(user.email, 1);
    await settle();
    expect(mailsTo(users[10].email)).toHaveLength(0);
  });

  it("one IP's fourth request for an address sends nothing; another IP's still does", async () => {
    const user = await createTestUser();
    const upper = user.email.replace(/^[a-z]/, (c) => c.toUpperCase());
    const ip = freshIp();

    for (const email of [user.email, upper, user.email, upper]) {
      await send(email, ip, 1);
    }
    await waitForMails(user.email, 3);
    await settle();
    expect(mailsTo(user.email)).toHaveLength(3);

    await send(user.email, freshIp(), 1);
    await waitForMails(user.email, 4);
  });

  it("an address's eleventh request in an hour, from several IPs, answers 202 and sends nothing", async () => {
    const user = await createTestUser();

    for (let i = 0; i < 3; i++) await send(user.email, freshIp(), 3);
    await send(user.email, freshIp(), 2);

    await waitForMails(user.email, 10);
    await settle();
    expect(mailsTo(user.email)).toHaveLength(10);
  });
});
