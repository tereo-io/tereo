import { dispatchNotification } from "../../utils/notifications/dispatch.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { ensureDailyPartitions } from "../../utils/partitions.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import type { Job } from "bullmq";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../jobs/notificationQueues.js";

// The delivery worker does not run under test, so a queued job stays waiting.
describe("dispatching a notification", () => {
  const created: string[] = [];

  beforeAll(async () => {
    await ensureDailyPartitions("notifications", 0, 1);
    await ensureDailyPartitions("notificationDeliveries", 0, 1);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
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

  it("fails, to be dispatched again, while a pending delivery's job is still running", async () => {
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
        [{ recipients: [{ address: "ops@example.com", as: "to" }] }]
      )
    );
    created.push(notification.id);
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    const payload = {
      notificationId: notification.id,
      createdAt: notification.createdAt.toISOString(),
    };
    const queue = getNotificationQueue("email");

    // The job of an attempt that failed it, still finishing when a retry
    // put the delivery back to pending.
    vi.spyOn(queue, "getJob").mockResolvedValueOnce({
      getState: async () => "active",
    } as unknown as Job);
    await expect(dispatchNotification(payload)).rejects.toThrow(
      /still running/
    );
    expect(await queue.getJob(delivery.id)).toBeUndefined();

    // Dispatched again once that job has finished.
    await dispatchNotification(payload);
    expect(await (await queue.getJob(delivery.id))?.getState()).toBe("waiting");
  });
});
