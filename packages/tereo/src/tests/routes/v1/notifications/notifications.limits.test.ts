// @module-tag int
// @module-tag notifications
import { ensureDailyPartitions } from "../../../../utils/partitions.js";
import { getTestPrincipalToken } from "../../../support/principals.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import { randomBytes, randomUUID } from "crypto";
import {
  cleanNotifications,
  createNotificationConnection,
  notificationMessage,
  sendNotification,
  expectError,
  currentVersion,
} from "../../../support/notifications.js";
import {
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  grantTestPermission,
  uploadTestObjectAndGetId,
} from "../../../support/files.js";

const rand = () => randomBytes(4).toString("hex");

let senderToken: string;
let senderId: string;

let connectionSlug: string;

let readableBucket: string;

let otherObjectId: string;

const message = (over: Record<string, unknown> = {}) =>
  notificationMessage(connectionSlug, over);

const send = (body: unknown, token = senderToken) =>
  sendNotification(token, body);

beforeAll(async () => {
  await ensureDailyPartitions("notifications", 0, 1);
  await ensureDailyPartitions("notificationDeliveries", 0, 1);
  await cleanNotifications();

  senderId = randomUUID();
  senderToken = await getTestPrincipalToken({
    userId: senderId,
    permissions: ["notifications.send", "file-service.objects.read"],
  });

  const connection = await createNotificationConnection({ isDefault: true });
  connectionSlug = connection.slug;

  const filesToken = await getTestAccessToken();
  readableBucket = (await createTestBucket(filesToken)).name;

  await grantTestPermission(filesToken, readableBucket, senderId, {
    canRead: true,
  });

  otherObjectId = await uploadTestObjectAndGetId(
    filesToken,
    readableBucket,
    "docs/other.txt",
    createTestFile(`other ${rand()}`, "other.txt", "text/plain")
  );
});

afterAll(async () => {
  await cleanNotifications();
  await cleanupTestEntities();
});

describe("POST /v1/notifications", () => {
  describe("accept-time checks", () => {
    it("refuses more than 50 recipients", async () => {
      const recipients = Array.from({ length: 51 }, (_, i) => ({
        address: `r${i}@example.com`,
      }));
      expectError(
        await send(message({ recipients })),
        400,
        "too_many_recipients"
      );
    });

    it("refuses attachments over 20 MB in total", async () => {
      const version = await currentVersion(otherObjectId);
      const blob = version.contentBlob!;
      await prisma.contentBlob.update({
        where: { hash: blob.hash },
        data: { sizeBytes: BigInt(11 * 1024 * 1024) },
      });
      try {
        const attachment = {
          bucket: readableBucket,
          objectId: otherObjectId,
          versionId: version.id,
        };
        expectError(
          await send(message({ attachments: [attachment, attachment] })),
          400,
          "attachments_too_large"
        );
      } finally {
        await prisma.contentBlob.update({
          where: { hash: blob.hash },
          data: { sizeBytes: blob.sizeBytes },
        });
      }
    });
  });
});
