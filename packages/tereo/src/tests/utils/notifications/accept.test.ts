// @module-tag int
// @module-tag notifications
import { ensureDailyPartitions } from "../../../utils/partitions.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  cleanNotifications,
  createNotificationConnection,
  notificationMessage,
  sendNotification,
} from "../../support/notifications.js";
import {
  ensureTestUser,
  getTestPrincipalToken,
} from "../../support/principals.js";

describe("validateNotification", () => {
  let token: string;
  let connectionSlug: string;
  let recipientUserId: string;

  beforeAll(async () => {
    await ensureDailyPartitions("notifications", 0, 1);
    await ensureDailyPartitions("notificationDeliveries", 0, 1);
    await cleanNotifications();
    token = await getTestPrincipalToken({
      userId: randomUUID(),
      permissions: ["notifications.send"],
    });
    connectionSlug = (await createNotificationConnection({ isDefault: true }))
      .slug;
    recipientUserId = await ensureTestUser(randomUUID());
  });

  afterAll(async () => {
    await cleanNotifications();
  });

  it("finds a recipient whose userId is given in upper case, and stores it in lower case", async () => {
    const res = await sendNotification(
      token,
      notificationMessage(connectionSlug, {
        recipients: [{ userId: recipientUserId.toUpperCase() }],
      })
    );
    expect(res.status, JSON.stringify(res.body)).toBe(202);

    const row = await prisma.notification.findFirstOrThrow({
      where: { id: res.body.id },
    });
    expect(row.recipients).toEqual([
      expect.objectContaining({ userId: recipientUserId }),
    ]);
  });
});
