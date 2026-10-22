// @module-tag int
// @module-tag notifications
// @module-tag job
import { processNotificationDelivery } from "../../jobs/notificationDelivery.js";
import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureDailyPartitions } from "../../utils/partitions.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { randomBytes } from "crypto";
import env from "../../env.js";
import {
  processStaleNotificationDeliveries,
  STRANDED_PENDING_PAGE,
  STRANDED_PENDING_MS,
} from "../../jobs/notificationStaleSweep.js";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../jobs/notificationQueues.js";
import {
  startFakeSmtpServer,
  type FakeSmtpServer,
} from "../support/fakeSmtpServer.js";

const MINUTE = 60_000;

describe("processStaleNotificationDeliveries", () => {
  // The delivery worker does not run under test, so a re-queued job stays
  // waiting and the queue can be inspected.
  describe("stale sending sweep", () => {
    const created: string[] = [];

    beforeAll(async () => {
      await ensureDailyPartitions("notifications", 0, 1);
      await ensureDailyPartitions("notificationDeliveries", 0, 1);
    });

    afterAll(async () => {
      const queue = getNotificationQueue("email");
      const deliveries = await prisma.notificationDelivery.findMany({
        where: { notificationId: { in: created } },
      });
      for (const d of deliveries) await queue.remove(d.id).catch(() => {});
      await prisma.notificationDelivery.deleteMany({
        where: { notificationId: { in: created } },
      });
      await prisma.notification.deleteMany({ where: { id: { in: created } } });
      await closeNotificationQueues();
    });

    /** A delivery left `sending`, last touched `ageMs` ago; no outbox row. */
    const sendingDelivery = (ageMs: number) => seedDelivery("sending", ageMs);

    const seedDelivery = async (
      status: "pending" | "sending",
      ageMs: number
    ) => {
      const notification = await prisma.$transaction((tx) =>
        db.notifications.insert(
          tx,
          {
            channel: "email",
            senderUserId: SYSTEM_USER_ID,
            recipients: [{ address: "ops@example.com" }],
            content: { subject: "Hi", text: "x" },
            attachments: [],
          },
          [
            {
              recipients: [{ address: "ops@example.com", as: "to" }],
              status,
              attempts: 1,
            },
          ]
        )
      );
      created.push(notification.id);
      await prisma.$executeRaw`
      UPDATE "notifications"."deliveries"
      SET "updated_at" = ${new Date(Date.now() - ageMs)}
      WHERE "notification_id" = ${notification.id}::uuid`;
      return prisma.notificationDelivery.findFirstOrThrow({
        where: { notificationId: notification.id },
      });
    };

    it("puts a delivery sending for over 15 minutes back to pending and re-queues it", async () => {
      const stale = await sendingDelivery(16 * MINUTE);
      const fresh = await sendingDelivery(14 * MINUTE);

      const requeued = await processStaleNotificationDeliveries();
      expect(requeued).toContain(stale.id);
      expect(requeued).not.toContain(fresh.id);

      const after = await prisma.notificationDelivery.findFirstOrThrow({
        where: { id: stale.id },
      });
      expect(after).toMatchObject({ status: "pending", attempts: 1 });
      const job = await getNotificationQueue("email").getJob(stale.id);
      expect(job?.data).toMatchObject({
        deliveryId: stale.id,
        notificationId: stale.notificationId,
      });

      const untouched = await prisma.notificationDelivery.findFirstOrThrow({
        where: { id: fresh.id },
      });
      expect(untouched.status).toBe("sending");
      expect(untouched.updatedAt).toEqual(fresh.updatedAt);
      expect(await getNotificationQueue("email").getJob(fresh.id)).toBeFalsy();
    });
  });

  describe("stranded pending sweep", () => {
    const created: string[] = [];
    let smtp: FakeSmtpServer;
    const allowPrivateHosts = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;

    beforeAll(async () => {
      env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = true;
      await ensureDailyPartitions("notifications", 0, 1);
      await ensureDailyPartitions("notificationDeliveries", 0, 1);
      await ensureDefaultOrganization();
      smtp = await startFakeSmtpServer();
      await prisma.notificationConnection.updateMany({
        where: { channel: "email", isDefault: true },
        data: { isDefault: false },
      });
      const connection = await prisma.notificationConnection.create({
        data: {
          channel: "email",
          slug: `sweep-${randomBytes(4).toString("hex")}`,
          displayName: "Sweep",
          settings: {
            host: "127.0.0.1",
            port: smtp.port,
            security: "none",
            defaultFrom: { address: "billing@acme.com" },
            allowedSenders: ["@acme.com"],
          },
          isDefault: true,
          createdBy: SYSTEM_USER_ID,
          updatedBy: SYSTEM_USER_ID,
        },
      });
      connectionId = connection.id;
    });

    let connectionId: string;

    afterAll(async () => {
      const queue = getNotificationQueue("email");
      const deliveries = await prisma.notificationDelivery.findMany({
        where: { notificationId: { in: created } },
      });
      for (const d of deliveries) await queue.remove(d.id).catch(() => {});
      await prisma.notificationDelivery.deleteMany({
        where: { notificationId: { in: created } },
      });
      await prisma.notification.deleteMany({ where: { id: { in: created } } });
      await prisma.notificationConnection.delete({
        where: { id: connectionId },
      });
      await closeNotificationQueues();
      await smtp.close();
      env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = allowPrivateHosts;
    });

    const pendingDelivery = async (ageMs: number) => {
      const notification = await prisma.$transaction((tx) =>
        db.notifications.insert(
          tx,
          {
            channel: "email",
            senderUserId: SYSTEM_USER_ID,
            recipients: [{ address: "ops@example.com" }],
            content: { subject: "Stranded", text: "x" },
            attachments: [],
          },
          [{ recipients: [{ address: "ops@example.com", as: "to" }] }]
        )
      );
      created.push(notification.id);
      await prisma.$executeRaw`
      UPDATE "notifications"."deliveries"
      SET "updated_at" = ${new Date(Date.now() - ageMs)}
      WHERE "notification_id" = ${notification.id}::uuid`;
      return prisma.notificationDelivery.findFirstOrThrow({
        where: { notificationId: notification.id },
      });
    };

    it("queues a pending delivery left with no job, which then sends", async () => {
      const stranded = await pendingDelivery(STRANDED_PENDING_MS + MINUTE);
      // As old as one waiting out the longest backoff: not looked at.
      const recent = await pendingDelivery(65 * MINUTE);

      const requeued = await processStaleNotificationDeliveries();
      expect(requeued).toContain(stranded.id);
      expect(requeued).not.toContain(recent.id);
      expect(await getNotificationQueue("email").getJob(recent.id)).toBeFalsy();

      const job = await getNotificationQueue("email").getJob(stranded.id);
      expect(job?.data).toMatchObject({
        deliveryId: stranded.id,
        notificationId: stranded.notificationId,
      });
      await processNotificationDelivery(job!);
      const after = await prisma.notificationDelivery.findFirstOrThrow({
        where: { id: stranded.id },
      });
      expect(after.status).toBe("sent");
      expect(smtp.messages.map((m) => m.parsed.subject)).toContain("Stranded");
    });

    it("leaves a pending delivery whose job is delayed alone", async () => {
      const waiting = await pendingDelivery(STRANDED_PENDING_MS + MINUTE);
      const queue = getNotificationQueue("email");
      await queue.add(
        "notification-delivery",
        {
          deliveryId: waiting.id,
          notificationId: waiting.notificationId,
          notificationCreatedAt: waiting.notificationCreatedAt.toISOString(),
        },
        { jobId: waiting.id, delay: 60 * MINUTE }
      );
      const before = await queue.getJob(waiting.id);

      const requeued = await processStaleNotificationDeliveries();
      expect(requeued).not.toContain(waiting.id);
      const after = await queue.getJob(waiting.id);
      expect(await after!.getState()).toBe("delayed");
      expect(after!.timestamp).toBe(before!.timestamp);
    });

    it("reaches a stranded delivery behind a full page of ones with live jobs", async () => {
      // A rate-limited backlog: older, and each with a delayed job, since a
      // delay for maxPerMinute leaves updated_at alone.
      const backlog = await prisma.$transaction((tx) =>
        db.notifications.insert(
          tx,
          {
            channel: "email",
            senderUserId: SYSTEM_USER_ID,
            recipients: [{ address: "ops@example.com" }],
            content: { subject: "Backlog", text: "x" },
            attachments: [],
          },
          Array.from({ length: STRANDED_PENDING_PAGE }, () => ({
            recipients: [{ address: "ops@example.com", as: "to" }],
          }))
        )
      );
      created.push(backlog.id);
      await prisma.$executeRaw`
      UPDATE "notifications"."deliveries"
      SET "updated_at" = ${new Date(Date.now() - 3 * 60 * MINUTE)}
      WHERE "notification_id" = ${backlog.id}::uuid`;
      const rows = await prisma.notificationDelivery.findMany({
        where: { notificationId: backlog.id },
      });
      await getNotificationQueue("email").addBulk(
        rows.map((d) => ({
          name: "notification-delivery",
          data: {
            deliveryId: d.id,
            notificationId: backlog.id,
            notificationCreatedAt: backlog.createdAt.toISOString(),
          },
          opts: { jobId: d.id, delay: 30 * MINUTE },
        }))
      );
      const stranded = await pendingDelivery(STRANDED_PENDING_MS + 5 * MINUTE);

      const requeued = await processStaleNotificationDeliveries();

      expect(requeued).toContain(stranded.id);
      expect(requeued).not.toContain(rows[0].id);
    }, 120_000);

    it("ignores a late markSent once the delivery was put back to pending", async () => {
      const reset = await pendingDelivery(0);
      const ref = {
        id: reset.id,
        notificationCreatedAt: reset.notificationCreatedAt,
      };
      const { count } = await db.notifications.markSent(prisma, ref, {
        providerMessageId: "<late@acme.com>",
        providerResponse: "250 OK",
      });
      expect(count).toBe(0);
      const after = await prisma.notificationDelivery.findFirstOrThrow({
        where: { id: reset.id },
      });
      expect(after).toMatchObject({
        status: "pending",
        providerMessageId: null,
        sentAt: null,
      });
    });
  });
});
