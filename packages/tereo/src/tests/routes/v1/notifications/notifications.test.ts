// @module-tag int
// @module-tag notifications
import { ensureDailyPartitions } from "../../../../utils/partitions.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SYSTEM_USER_ID } from "../../../../definitions/index.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { waitFor } from "../../../support/webhooks.js";
import { CORE_URL } from "../../../support/coreUrl.js";
import { fetchJson } from "../../../support/http.js";
import { randomBytes, randomUUID } from "crypto";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../../../jobs/notificationQueues.js";
import {
  ensureTestUser,
  getTestPrincipalToken,
} from "../../../support/principals.js";
import {
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  grantTestPermission,
  uploadTestObjectAndGetId,
} from "../../../support/files.js";

const BASE = `${CORE_URL}/v1/notifications`;

// The delivery worker does not run under test, so a dispatched job waits.
const waitForDeliveryJob = async (deliveryId: string) => {
  const queue = getNotificationQueue("email");
  await waitFor(async () => (await queue.getJob(deliveryId)) !== undefined);
  return (await queue.getJob(deliveryId))!;
};

const rand = () => randomBytes(4).toString("hex");

const api = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => fetchJson(method, `${BASE}${path}`, token, body);

const settings = {
  host: "127.0.0.1",
  port: 2525,
  security: "none",
  defaultFrom: { address: "billing@acme.com" },
  allowedSenders: ["@acme.com"],
};

const clean = async () => {
  await prisma.notificationDelivery.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.notificationConnection.deleteMany();
};

const createConnection = (over: Record<string, unknown> = {}) =>
  prisma.notificationConnection.create({
    data: {
      channel: "email",
      slug: `c-${rand()}`,
      displayName: "Test",
      settings,
      createdBy: SYSTEM_USER_ID,
      updatedBy: SYSTEM_USER_ID,
      ...over,
    },
  });

let senderToken: string;
let senderId: string;

let connectionSlug: string;
let connectionId: string;

let recipientUserId: string;
let recipientEmail: string;
let readableBucket: string;

let objectId: string;
let versionId: string;

let objectSize: number;

const currentVersion = async (id: string) =>
  (await prisma.objectVersion.findFirstOrThrow({
    where: { objectId: id, isCurrent: true },
    include: { contentBlob: true },
  }))!;

const message = (over: Record<string, unknown> = {}) => ({
  channel: "email",
  connection: connectionSlug,
  recipients: [{ address: "ops@example.com" }],
  content: { subject: "Invoice 1042", text: "Hello" },
  ...over,
});

const send = (body: unknown, token = senderToken) =>
  api("POST", "", token, body);

const expectError = (
  res: { status: number; body: { error?: string } },
  status: number,
  code: string
) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.error).toBe(code);
};

beforeAll(async () => {
  await ensureDailyPartitions("notifications", 0, 1);
  await ensureDailyPartitions("notificationDeliveries", 0, 1);
  await clean();

  senderId = randomUUID();
  senderToken = await getTestPrincipalToken({
    userId: senderId,
    permissions: ["notifications.send", "file-service.objects.read"],
  });

  const connection = await createConnection({ isDefault: true });
  connectionSlug = connection.slug;
  connectionId = connection.id;

  recipientUserId = await ensureTestUser(randomUUID());
  recipientEmail = (
    await prisma.user.findUniqueOrThrow({ where: { id: recipientUserId } })
  ).email;

  const filesToken = await getTestAccessToken();
  readableBucket = (await createTestBucket(filesToken)).name;

  await grantTestPermission(filesToken, readableBucket, senderId, {
    canRead: true,
  });

  objectId = await uploadTestObjectAndGetId(
    filesToken,
    readableBucket,
    "docs/report.txt",
    createTestFile(`report ${rand()}`, "report.txt", "text/plain")
  );
  const version = await currentVersion(objectId);
  versionId = version.id;
  objectSize = Number(version.contentBlob!.sizeBytes);
});

afterAll(async () => {
  await clean();
  await cleanupTestEntities();
  await closeNotificationQueues();
});

describe("POST /v1/notifications", () => {
  describe("accepted", () => {
    let id: string;

    it("answers 202 and writes the notification, its delivery, an audit entry and an outbox row", async () => {
      const res = await send(
        message({
          recipients: [
            { address: "ops@example.com" },
            { userId: recipientUserId, as: "cc" },
          ],
          attachments: [{ bucket: readableBucket, objectId, versionId }],
        })
      );
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expect(res.body).toEqual({ id: expect.any(String), status: "pending" });
      id = res.body.id;

      const row = await prisma.notification.findFirstOrThrow({
        where: { id },
        include: { deliveries: true },
      });
      expect(row).toMatchObject({
        channel: "email",
        connectionId,
        senderUserId: senderId,
        status: "pending",
        content: { subject: "Invoice 1042", text: "Hello" },
        summary: "Invoice 1042",
        attachments: [
          {
            bucket: readableBucket,
            objectId,
            versionId,
            filename: "report.txt",
            contentType: "text/plain",
            size: objectSize,
          },
        ],
      });
      expect(row.deliveries).toHaveLength(1);
      expect(row.deliveries[0].status).toBe("pending");
      expect(row.deliveries[0].recipients).toEqual([
        { address: "ops@example.com", as: "to" },
        { address: recipientEmail, as: "cc", userId: recipientUserId },
      ]);

      const audit = await prisma.auditLogEntry.findFirst({
        where: { entityType: "Notification", entityId: id },
      });
      expect(audit).toMatchObject({ action: "CREATE", userId: senderId });

      // The server's reaper may have dispatched the outbox row and deleted it
      // already. Dispatch finds the notification by the payload's id and
      // createdAt, so its delivery being queued shows the row was right.
      const outbox = await prisma.$queryRaw<{ payload: unknown }[]>`
        SELECT payload FROM "core"."outbox"
        WHERE destination = 'notification' AND payload->>'notificationId' = ${id}`;
      for (const r of outbox) {
        expect(r.payload).toEqual({
          notificationId: id,
          createdAt: row.createdAt.toISOString(),
        });
      }
      expect(outbox.length).toBeLessThanOrEqual(1);
      const job = await waitForDeliveryJob(row.deliveries[0].id);
      expect(job.data).toMatchObject({
        deliveryId: row.deliveries[0].id,
        notificationId: id,
        notificationCreatedAt: row.createdAt.toISOString(),
      });
    });
  });

  describe("idempotency", () => {
    it("replays the first result for the same key and body", async () => {
      const body = message({ idempotencyKey: randomUUID() });
      const first = await send(body);
      const second = await send(body);
      expect(first.status, JSON.stringify(first.body)).toBe(202);
      expect(second.status).toBe(202);
      expect(second.body.id).toBe(first.body.id);
      expect(
        await prisma.notification.count({ where: { id: first.body.id } })
      ).toBe(1);
      expect(
        await prisma.auditLogEntry.count({
          where: { entityType: "Notification", entityId: first.body.id },
        })
      ).toBe(1);
    });

    it("refuses the same key with a different body", async () => {
      const idempotencyKey = randomUUID();
      expect((await send(message({ idempotencyKey }))).status).toBe(202);
      expectError(
        await send(
          message({
            idempotencyKey,
            content: { subject: "Other", text: "x" },
          })
        ),
        422,
        "idempotency_key_conflict"
      );
    });

    it("refuses the same key with a different, invalid body", async () => {
      const idempotencyKey = randomUUID();
      expect((await send(message({ idempotencyKey }))).status).toBe(202);
      expectError(
        await send(
          message({ idempotencyKey, content: { subject: "No body" } })
        ),
        422,
        "idempotency_key_conflict"
      );
    });

    it("replays the first result after a recipient is deactivated", async () => {
      const user = await prisma.user.create({
        data: { email: `replay-${rand()}@example.com`, passwordHash: "!" },
      });
      const body = message({
        idempotencyKey: randomUUID(),
        recipients: [{ userId: user.id }],
      });
      const first = await send(body);
      expect(first.status, JSON.stringify(first.body)).toBe(202);

      const sent = () =>
        prisma.notification.count({ where: { senderUserId: senderId } });
      const before = await sent();

      await prisma.user.update({
        where: { id: user.id },
        data: { isActive: false },
      });
      const second = await send(body);
      expect(second.status, JSON.stringify(second.body)).toBe(202);
      expect(second.body.id).toBe(first.body.id);
      expect(await sent()).toBe(before);
    });

    it("replays the first result after the named connection is disabled", async () => {
      const connection = await createConnection();
      const body = message({
        idempotencyKey: randomUUID(),
        connection: connection.slug,
      });
      const first = await send(body);
      expect(first.status, JSON.stringify(first.body)).toBe(202);

      await prisma.notificationConnection.update({
        where: { id: connection.id },
        data: { isEnabled: false },
      });
      const second = await send(body);
      expect(second.status, JSON.stringify(second.body)).toBe(202);
      expect(second.body.id).toBe(first.body.id);
      expect(
        await prisma.notification.count({
          where: { connectionId: connection.id },
        })
      ).toBe(1);
    });
  });

  describe("with no connection", () => {
    it("still accepts a send when the channel has no default and none is named", async () => {
      await clean();
      const res = await send(message({ connection: undefined }));
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      const row = await prisma.notification.findFirstOrThrow({
        where: { id: res.body.id },
      });
      expect(row).toMatchObject({ connectionId: null, status: "pending" });
    });
  });
});
