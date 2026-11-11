// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { BASE_URL, HTTP_STATUS } from "../../../support/auth/constants.js";
import { getTestPrincipalToken } from "../../../support/principals.js";
import { createGuest, issue } from "../../../support/passwordSetup.js";
import { SYSTEM_USER_ID } from "../../../../definitions/index.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { waitFor } from "../../../support/webhooks.js";
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

describe("password setup", () => {
  beforeAll(async () => {
    await ensureDefaultOrganization();
  });

  describe("issuePasswordLink with notify", () => {
    const allowPrivateHosts = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;
    let smtp: FakeSmtpServer;

    beforeAll(async () => {
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

    it("refuses without an email connection and writes nothing", async () => {
      const guest = await createGuest();

      await expect(issue(guest.id, true)).rejects.toMatchObject({
        code: "email_not_configured",
        statusCode: 409,
      });
      expect(
        await prisma.userLinkToken.count({ where: { userId: guest.id } })
      ).toBe(0);
      expect(await prisma.notification.count()).toBe(0);
    });

    it("sends the link to the user's address", async () => {
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
      const guest = await createGuest();
      const token = await issue(guest.id, true);

      await waitFor(async () => smtp.messages.length === 1, 10_000, 50);
      const [message] = smtp.messages;
      expect(message.rcpt).toEqual([guest.email]);
      expect(message.parsed.text).toContain(`/set-password#token=${token}`);
    });

    const smtpSettings = (port: number) => ({
      host: "127.0.0.1",
      port,
      security: "none",
      defaultFrom: { address: "billing@acme.com" },
      allowedSenders: ["@acme.com"],
    });

    const notificationOfUser = async (email: string) => {
      let found: Awaited<ReturnType<typeof prisma.notification.findFirst>> =
        null;
      await waitFor(
        async () => {
          found = await prisma.notification.findFirst({
            where: { recipients: { path: ["0", "address"], equals: email } },
          });
          return found !== null;
        },
        5000,
        50
      );
      return found!;
    };

    it("marks the notification sensitive and drops its content once sent", async () => {
      await createNotificationConnection({
        isDefault: true,
        settings: smtpSettings(smtp.port),
      });
      const guest = await createGuest();
      await issue(guest.id, true);
      const n = await notificationOfUser(guest.email);
      expect(n.sensitive).toBe(true);

      await waitFor(
        async () =>
          (await prisma.notification.findFirstOrThrow({ where: { id: n.id } }))
            .status === "sent",
        10_000,
        50
      );
      const done = await prisma.notification.findFirstOrThrow({
        where: { id: n.id },
      });
      expect(done.content).toBeNull();
    });

    it("drops the content once the delivery has failed", async () => {
      const refusing = await startFakeSmtpServer({ reply: () => 550 });
      try {
        await createNotificationConnection({
          isDefault: true,
          settings: smtpSettings(refusing.port),
        });
        const guest = await createGuest();
        await issue(guest.id, true);
        const n = await notificationOfUser(guest.email);

        await waitFor(
          async () =>
            (
              await prisma.notification.findFirstOrThrow({
                where: { id: n.id },
              })
            ).status === "failed",
          10_000,
          50
        );
        const done = await prisma.notification.findFirstOrThrow({
          where: { id: n.id },
        });
        expect(done.content).toBeNull();
      } finally {
        await refusing.close();
      }
    });

    it("does not return a pending sensitive notification's content from the log", async () => {
      const conn = await createNotificationConnection({ isDefault: true });
      const row = await prisma.notification.create({
        data: {
          channel: "email",
          connectionId: conn.id,
          senderUserId: SYSTEM_USER_ID,
          recipients: [{ address: "x@test.local" }],
          content: {
            subject: "s",
            text: "https://x/set-password#token=SECRET",
          },
          sensitive: true,
          attachments: [],
        },
      });
      const token = await getTestPrincipalToken({
        permissions: ["notifications.read"],
      });

      const res = await axios.get(
        `${BASE_URL}/v1/admin/notifications/${row.id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data.content).toBeNull();
      expect(res.data.contentRedacted).toBe(true);
      expect(JSON.stringify(res.data)).not.toContain("SECRET");
    });
  });
});
