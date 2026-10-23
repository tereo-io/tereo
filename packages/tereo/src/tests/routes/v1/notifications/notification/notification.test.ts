// @module-tag int
// @module-tag notifications
import { ensureDailyPartitions } from "../../../../../utils/partitions.js";
import { getTestPrincipalToken } from "../../../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import {
  notificationsApi,
  cleanNotifications,
  createNotificationConnection,
  notificationMessage,
  sendNotification,
  expectError,
} from "../../../../support/notifications.js";

let senderToken: string;
let otherSenderToken: string;
let readerToken: string;
let noPermToken: string;
let connectionSlug: string;

const message = (over: Record<string, unknown> = {}) =>
  notificationMessage(connectionSlug, over);

const send = (body: unknown, token = senderToken) =>
  sendNotification(token, body);

beforeAll(async () => {
  await ensureDailyPartitions("notifications", 0, 1);
  await ensureDailyPartitions("notificationDeliveries", 0, 1);
  await cleanNotifications();

  senderToken = await getTestPrincipalToken({
    permissions: ["notifications.send"],
  });
  otherSenderToken = await getTestPrincipalToken({
    permissions: ["notifications.send"],
  });
  readerToken = await getTestPrincipalToken({
    permissions: ["notifications.read"],
  });
  noPermToken = await getTestPrincipalToken({
    permissions: ["audit-logs.read"],
  });

  const connection = await createNotificationConnection({ isDefault: true });
  connectionSlug = connection.slug;
});

afterAll(async () => {
  await cleanNotifications();
});

describe("GET /v1/notifications/:id", () => {
  describe("accepted", () => {
    let id: string;

    beforeAll(async () => {
      id = (await send(message())).body.id;
    });

    it("lets the sender read their own send, with deliveries", async () => {
      const res = await notificationsApi("GET", `/${id}`, senderToken);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        id,
        status: "pending",
        summary: "Invoice 1042",
      });
      expect(res.body.deliveries).toHaveLength(1);
      expect(res.body).not.toHaveProperty("content");
    });

    it("lets notifications.read read any send", async () => {
      expect(
        (await notificationsApi("GET", `/${id}`, readerToken)).status
      ).toBe(200);
    });

    it("hides another sender's send from a send-only caller", async () => {
      expectError(
        await notificationsApi("GET", `/${id}`, otherSenderToken),
        404,
        "not_found"
      );
    });

    it("answers 404 for an unknown id", async () => {
      expectError(
        await notificationsApi("GET", `/${randomUUID()}`, readerToken),
        404,
        "not_found"
      );
    });

    it("refuses a caller with neither send nor read", async () => {
      expect(
        (await notificationsApi("GET", `/${id}`, noPermToken)).status
      ).toBe(403);
    });
  });
});
