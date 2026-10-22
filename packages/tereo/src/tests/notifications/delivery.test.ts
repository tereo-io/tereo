import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { ensureDailyPartitions } from "../../utils/partitions.js";
import { getTestPrincipalToken } from "../support/principals.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { TEST_SERVICE_ID } from "../support/testService.js";
import type { Prisma } from "../../utils/db/prisma.js";
import { prisma } from "../../utils/db/prisma.js";
import { waitFor } from "../support/webhooks.js";
import { notifyTx } from "../../utils/outbox.js";
import { randomBytes, randomUUID } from "crypto";
import { CORE_URL } from "../support/coreUrl.js";
import db from "../../utils/db/index.js";
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
  type CapturedMessage,
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

type Tx = Prisma.TransactionClient;

const rand = () => randomBytes(4).toString("hex");
const TIMEOUT = 15_000;

let smtp: FakeSmtpServer;
let reply: (msg: CapturedMessage) => number = () => 250;
let refused: string[] = [];
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

/** Accept a send as core; `then` runs in the same transaction, after it. */
const accept = async (
  over: Record<string, unknown> = {},
  then?: (tx: Tx) => Promise<unknown>
) =>
  prisma.$transaction(async (tx) => {
    const { id } = await notifyTx(tx, input(over));
    await then?.(tx);
    return id;
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

/** The webhook event, which the server's reaper fans out (here: to no endpoint). */
// Core's own events are audited by the mutation that emits them, not by the
// fan-out, so an endpoint of all organizations stands in as their receiver.
let eventReceiverId: string;

const waitForEvent = (eventType: string, notificationId: string) =>
  waitFor(
    async () =>
      (await prisma.webhookDelivery.findFirst({
        where: {
          webhookEndpointId: eventReceiverId,
          eventType,
          payload: { path: ["entityId"], equals: notificationId },
        },
      })) !== null,
    TIMEOUT,
    100
  );

beforeAll(async () => {
  env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = true;
  await ensureDailyPartitions("notifications", 0, 1);
  await ensureDailyPartitions("notificationDeliveries", 0, 1);
  await ensureDefaultOrganization();
  await clean();
  await getNotificationQueue("email").obliterate({ force: true });
  eventReceiverId = (
    await db.webhookEndpoints.create({
      organizationId: null,
      ownerServiceId: TEST_SERVICE_ID,
      createdBy: SYSTEM_USER_ID,
      url: "https://example.com/notification-events",
      eventTypes: ["notification.sent", "notification.failed"],
    })
  ).endpoint.id;

  smtp = await startFakeSmtpServer({
    reply: (m) => reply(m),
    refuseRecipient: (address) => refused.includes(address),
  });
  bucket = (await createTestBucket(await getTestAccessToken())).name;
  await startNotificationDeliveryWorker();
});

beforeEach(async () => {
  reply = () => 250;
  refused = [];
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
  await prisma.webhookDelivery.deleteMany({
    where: { webhookEndpointId: eventReceiverId },
  });
  await prisma.webhookEndpoint.deleteMany({ where: { id: eventReceiverId } });
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

describe("notification delivery", () => {
  it("delivers an accepted send, records the reply and rolls up", async () => {
    const connection = await createConnection();
    const token = await getTestPrincipalToken({
      permissions: ["notifications.send"],
    });
    const res = await fetch(`${CORE_URL}/v1/notifications`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        input({ content: { subject: "Invoice 1042", text: "Hello" } })
      ),
    });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };

    const delivery = await waitForDelivery(id, (d) => d.status === "sent");
    expect(delivery).toMatchObject({
      attempts: 1,
      connectionId: connection.id,
      lastError: null,
      providerMessageId: `<${delivery.id}@acme.com>`,
      providerResponse: expect.stringMatching(/^250/),
    });
    expect(delivery.sentAt).toBeInstanceOf(Date);

    const notification = await notificationOf(id);
    expect(notification.status).toBe("sent");
    expect(notification.content).toBeNull();

    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0].parsed.subject).toBe("Invoice 1042");
    expect(smtp.messages[0].parsed.messageId).toBe(`<${delivery.id}@acme.com>`);
    await waitForEvent("notification.sent", id);
  });

  it("attaches the stored version's bytes", async () => {
    await createConnection();
    const body = `report ${rand()}`;
    const { objectId, versionId } = await upload(body);
    const id = await accept({
      attachments: [{ bucket, objectId, versionId, filename: "report.txt" }],
    });

    await waitForDelivery(id, (d) => d.status === "sent");
    const [attachment] = smtp.messages[0].parsed.attachments;
    expect(attachment.filename).toBe("report.txt");
    expect(attachment.content.toString("utf8")).toBe(body);
  });

  it("sends to and cc recipients as one message", async () => {
    await createConnection();
    const id = await accept({
      recipients: [
        { address: "to@example.com" },
        { address: "cc@example.com", as: "cc" },
      ],
    });

    await waitForDelivery(id, (d) => d.status === "sent");
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0].rcpt.sort()).toEqual([
      "cc@example.com",
      "to@example.com",
    ]);
  });

  it("records recipients the server refused while the rest are sent", async () => {
    await createConnection();
    refused = ["gone@example.com"];
    const id = await accept({
      recipients: [
        { address: "ops@example.com" },
        { address: "gone@example.com", as: "cc" },
      ],
    });

    const delivery = await waitForDelivery(id, (d) => d.status === "sent");
    expect(delivery.providerResponse).toMatch(
      /^250.*; rejected: gone@example\.com$/
    );
    expect(smtp.messages[0].rcpt).toEqual(["ops@example.com"]);
  });

  it("retries a transient failure and then sends", async () => {
    await createConnection();
    let calls = 0;
    reply = () => (++calls <= 2 ? 451 : 250);
    const id = await accept();
    const { id: deliveryId } = await waitForDelivery(id, () => true);

    for (const attempt of [1, 2]) {
      const d = await waitForDelivery(
        id,
        (x) => x.attempts === attempt && x.status === "pending"
      );
      expect(d.lastError).toMatch(/451/);
      await promoteWhenDelayed(deliveryId);
    }

    const delivery = await waitForDelivery(id, (d) => d.status === "sent");
    expect(delivery.attempts).toBe(3);
    expect(smtp.messages).toHaveLength(1);
    expect((await notificationOf(id)).status).toBe("sent");
  });

  it("fails a permanent rejection at once", async () => {
    await createConnection();
    reply = () => 550;
    const id = await accept();

    const delivery = await waitForDelivery(id, (d) => d.status === "failed");
    expect(delivery.attempts).toBe(1);
    expect(delivery.lastError).toMatch(/550/);
    const notification = await notificationOf(id);
    expect(notification.status).toBe("failed");
    expect(notification.content).not.toBeNull();
    await waitForEvent("notification.failed", id);
  });

  it("waits for a connection, then sends once one exists", async () => {
    const id = await accept();
    const waiting = await waitForDelivery(
      id,
      (d) => d.lastError === "no_connection"
    );
    expect(waiting).toMatchObject({ status: "pending", attempts: 0 });
    await waitFor(
      async () => (await jobState(waiting.id)) === "delayed",
      TIMEOUT,
      50
    );

    await createConnection();
    await promoteWhenDelayed(waiting.id);
    const delivery = await waitForDelivery(id, (d) => d.status === "sent");
    expect(delivery.attempts).toBe(1);
    expect(smtp.messages).toHaveLength(1);
  });

  it("delays a send over the connection's rate limit without failing it", async () => {
    await createConnection({ maxPerMinute: 1 });
    // Both sends must land in one fixed one-minute window.
    await waitFor(async () => 60_000 - (Date.now() % 60_000) > 20_000, 25_000);
    const first = await accept();
    const second = await accept();

    let held: Awaited<ReturnType<typeof deliveryOf>> | undefined;
    await waitFor(
      async () => {
        const deliveries = await prisma.notificationDelivery.findMany({
          where: { notificationId: { in: [first, second] } },
        });
        const sent = deliveries.filter((d) => d.status === "sent");
        const other = deliveries.find((d) => d.status !== "sent");
        if (sent.length !== 1 || !other) return false;
        held = other;
        return (await jobState(other.id)) === "delayed";
      },
      TIMEOUT,
      50
    );
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { id: held!.id },
    });
    expect(delivery).toMatchObject({ status: "pending", attempts: 0 });
    expect(smtp.messages).toHaveLength(1);
  });

  it("refuses a sender the connection resolved at send time does not allow", async () => {
    await createConnection({ domain: "a.com" });
    const b = await createConnection({ domain: "b.com", isDefault: false });
    // Accepted against A, then B becomes the default before dispatch.
    const id = await accept(
      { content: { subject: "Hi", text: "x", from: { address: "x@a.com" } } },
      (tx) => db.notificationConnections.setDefault(b.id, tx)
    );

    const delivery = await waitForDelivery(id, (d) => d.status === "failed");
    expect(delivery.lastError).toBe("sender_not_allowed");
    expect((await notificationOf(id)).status).toBe("failed");
    expect(smtp.messages).toHaveLength(0);
  });

  it("fails at once when an attachment's version is gone", async () => {
    await createConnection();
    const { objectId, versionId } = await upload(`gone ${rand()}`);
    const id = await accept(
      { attachments: [{ bucket, objectId, versionId }] },
      (tx) => tx.objectVersion.delete({ where: { id: versionId } })
    );

    const delivery = await waitForDelivery(id, (d) => d.status === "failed");
    expect(delivery).toMatchObject({
      lastError: "attachment_missing",
      attempts: 1,
    });
    expect(smtp.messages).toHaveLength(0);
  });

  it("refuses a stored plaintext connection without ALLOW_PLAINTEXT_SMTP", async () => {
    // Accepted while there is no connection, so the send waits for one.
    const id = await accept();
    const waiting = await waitForDelivery(
      id,
      (d) => d.lastError === "no_connection"
    );
    await waitFor(
      async () => (await jobState(waiting.id)) === "delayed",
      TIMEOUT,
      50
    );
    await createConnection();
    env.ALLOW_PLAINTEXT_SMTP = false;
    try {
      await expect(accept()).rejects.toMatchObject({
        code: "invalid_settings",
      });
      await promoteWhenDelayed(waiting.id);
      const delivery = await waitForDelivery(id, (d) => d.status === "failed");
      expect(delivery).toMatchObject({
        lastError: "invalid_settings",
        attempts: 1,
      });
      expect(smtp.messages).toHaveLength(0);
    } finally {
      env.ALLOW_PLAINTEXT_SMTP = true;
    }
  });

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
      await prisma.bucketPermission.deleteMany({ where: { userId: senderId } });
      await grantTestPermission(await getTestAccessToken(), bucket, senderId, {
        canRead: true,
      });
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

      const delivery = await waitForDelivery(id, (d) => d.status === "failed");
      expect(delivery).toMatchObject({
        lastError: "attachment_forbidden",
        attempts: 1,
      });
      expect((await notificationOf(id)).status).toBe("failed");
      expect(smtp.messages).toHaveLength(0);
    });
  });
});
