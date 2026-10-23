// @module-tag int
// @module-tag notifications
// @module-tag job
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { ensureDailyPartitions } from "../../utils/partitions.js";
import { getTestPrincipalToken } from "../support/principals.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { waitFor } from "../support/webhooks.js";
import { randomBytes, randomUUID } from "crypto";
import { CORE_URL } from "../support/coreUrl.js";
import env from "../../env.js";
import {
  startNotificationDeliveryWorker,
  stopNotificationDeliveryWorker,
} from "../../jobs/notificationDelivery.js";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../jobs/notificationQueues.js";
import {
  startFakeSmtpServer,
  type FakeSmtpServer,
} from "../support/fakeSmtpServer.js";
import {
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  grantTestPermission,
  uploadTestObjectAndGetId,
} from "../support/files.js";

// End to end: the server's outbox reaper dispatches each accepted send onto
// the channel's queue; this file runs the delivery worker, which the server
// does not under test. A retry's backoff (minutes) is cut short by promoting
// the delayed job once the attempt has been recorded.

const rand = () => randomBytes(4).toString("hex");
const TIMEOUT = 15_000;

let smtp: FakeSmtpServer;
let bucket: string;
const allowPrivateHosts = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;

const clean = async () => {
  await prisma.notificationDelivery.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.notificationConnection.deleteMany();
};

const createConnection = (
  over: {
    isDefault?: boolean;
    maxPerMinute?: number | null;
    domain?: string;
  } = {}
) => {
  const domain = over.domain ?? "acme.com";
  return prisma.notificationConnection.create({
    data: {
      channel: "email",
      slug: `c-${rand()}`,
      displayName: "Test",
      settings: {
        host: "127.0.0.1",
        port: smtp.port,
        security: "none",
        defaultFrom: { address: `billing@${domain}` },
        allowedSenders: [`@${domain}`],
      },
      isDefault: over.isDefault ?? true,
      maxPerMinute: over.maxPerMinute ?? null,
      createdBy: SYSTEM_USER_ID,
      updatedBy: SYSTEM_USER_ID,
    },
  });
};

const input = (over: Record<string, unknown> = {}) => ({
  channel: "email" as const,
  recipients: [{ address: "ops@example.com" }],
  content: { subject: `Invoice ${rand()}`, text: "Hello" },
  ...over,
});

const deliveryOf = (notificationId: string) =>
  prisma.notificationDelivery.findFirstOrThrow({ where: { notificationId } });

const notificationOf = (id: string) =>
  prisma.notification.findFirstOrThrow({ where: { id } });

const waitForDelivery = async (
  notificationId: string,
  done: (d: Awaited<ReturnType<typeof deliveryOf>>) => boolean
) => {
  await waitFor(
    async () => {
      const d = await prisma.notificationDelivery.findFirst({
        where: { notificationId },
      });
      return d !== null && done(d);
    },
    TIMEOUT,
    50
  );
  return deliveryOf(notificationId);
};

const jobState = async (deliveryId: string) => {
  const job = await getNotificationQueue("email").getJob(deliveryId);
  return job ? job.getState() : null;
};

/** Wait until the delivery's job is delayed, then run it now. */
const promoteWhenDelayed = async (deliveryId: string) => {
  await waitFor(
    async () => (await jobState(deliveryId)) === "delayed",
    TIMEOUT,
    50
  );
  await (await getNotificationQueue("email").getJob(deliveryId))!.promote();
};

beforeAll(async () => {
  env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = true;
  await ensureDailyPartitions("notifications", 0, 1);
  await ensureDailyPartitions("notificationDeliveries", 0, 1);
  await ensureDefaultOrganization();
  await clean();
  await getNotificationQueue("email").obliterate({ force: true });

  smtp = await startFakeSmtpServer();
  bucket = (await createTestBucket(await getTestAccessToken())).name;
  await startNotificationDeliveryWorker();
});

beforeEach(async () => {
  smtp.messages.length = 0;
  await clean();
});

afterAll(async () => {
  await stopNotificationDeliveryWorker();
  await getNotificationQueue("email")
    .obliterate({ force: true })
    .catch(() => {});
  await closeNotificationQueues();
  await smtp.close();
  await clean();
  await cleanupTestEntities();
  env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = allowPrivateHosts;
});

const upload = async (content: string) => {
  const objectId = await uploadTestObjectAndGetId(
    await getTestAccessToken(),
    bucket,
    `att/${rand()}.txt`,
    createTestFile(content, "att.txt", "text/plain")
  );
  const version = await prisma.objectVersion.findFirstOrThrow({
    where: { objectId, isCurrent: true },
  });
  return { objectId, versionId: version.id };
};

describe("processNotificationDelivery", () => {
  describe("notification delivery", () => {
    describe("attachment access", () => {
      let senderId: string;
      let senderToken: string;

      beforeAll(async () => {
        senderId = randomUUID();
        senderToken = await getTestPrincipalToken({
          userId: senderId,
          permissions: ["notifications.send", "file-service.objects.read"],
        });
      });

      beforeEach(async () => {
        await prisma.bucketPermission.deleteMany({
          where: { userId: senderId },
        });
        await grantTestPermission(
          await getTestAccessToken(),
          bucket,
          senderId,
          {
            canRead: true,
          }
        );
      });

      /** Accepted with no connection yet, so it waits until `release()`. */
      const sendHeld = async () => {
        const { objectId, versionId } = await upload(`held ${rand()}`);
        const res = await fetch(`${CORE_URL}/v1/notifications`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${senderToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            input({ attachments: [{ bucket, objectId, versionId }] })
          ),
        });
        expect(res.status).toBe(202);
        const { id } = (await res.json()) as { id: string };
        const waiting = await waitForDelivery(
          id,
          (d) => d.lastError === "no_connection"
        );
        await waitFor(
          async () => (await jobState(waiting.id)) === "delayed",
          TIMEOUT,
          50
        );
        const release = async () => {
          await createConnection();
          await promoteWhenDelayed(waiting.id);
        };
        return { id, release, versionId };
      };

      /** The bucket made public and the attachment's version made history. */
      const makeHistoryOnPublicBucket = async (versionId: string) => {
        await prisma.bucket.updateMany({
          where: { name: bucket },
          data: { policy: "public" },
        });
        await prisma.objectVersion.update({
          where: { id: versionId },
          data: { isCurrent: false },
        });
      };

      const revokeSenderGrant = async () => {
        const { id: bucketId } = await prisma.bucket.findFirstOrThrow({
          where: { name: bucket },
        });
        await prisma.bucketPermission.updateMany({
          where: { bucketId, userId: senderId },
          data: { revokedAt: new Date() },
        });
      };

      it("sends history of a public bucket while the sender holds a grant", async () => {
        const { id, release, versionId } = await sendHeld();
        try {
          await makeHistoryOnPublicBucket(versionId);
          await release();
          await waitForDelivery(id, (d) => d.status === "sent");
        } finally {
          await prisma.bucket.updateMany({
            where: { name: bucket },
            data: { policy: "private" },
          });
        }
      });

      it("fails when the version became public-bucket history and the grant was revoked", async () => {
        const { id, release, versionId } = await sendHeld();
        try {
          await makeHistoryOnPublicBucket(versionId);
          await revokeSenderGrant();
          await release();
          const delivery = await waitForDelivery(
            id,
            (d) => d.status === "failed"
          );
          expect(delivery).toMatchObject({
            lastError: "attachment_forbidden",
            attempts: 1,
          });
          expect(smtp.messages).toHaveLength(0);
        } finally {
          await prisma.bucket.updateMany({
            where: { name: bucket },
            data: { policy: "private" },
          });
        }
      });

      it("sends the attachment while the sender can still read its bucket", async () => {
        const { id, release } = await sendHeld();
        await release();
        await waitForDelivery(id, (d) => d.status === "sent");
        expect(smtp.messages[0].parsed.attachments).toHaveLength(1);
      });

      it("fails at once when the sender's bucket access was revoked after accept", async () => {
        const { id, release } = await sendHeld();
        const { id: bucketId } = await prisma.bucket.findFirstOrThrow({
          where: { name: bucket },
        });
        await prisma.bucketPermission.updateMany({
          where: { bucketId, userId: senderId },
          data: { revokedAt: new Date() },
        });
        await release();

        const delivery = await waitForDelivery(
          id,
          (d) => d.status === "failed"
        );
        expect(delivery).toMatchObject({
          lastError: "attachment_forbidden",
          attempts: 1,
        });
        expect((await notificationOf(id)).status).toBe("failed");
        expect(smtp.messages).toHaveLength(0);
      });
    });
  });
});
