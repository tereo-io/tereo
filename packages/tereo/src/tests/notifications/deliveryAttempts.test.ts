import { processNotificationDelivery } from "../../jobs/notificationDelivery.js";
import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { smtpTimeouts } from "../../utils/notifications/channels/email.js";
import { ensureDailyPartitions } from "../../utils/partitions.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { DelayedError, type Job } from "bullmq";
import { logger } from "../../utils/logger.js";
import db from "../../utils/db/index.js";
import { randomBytes } from "crypto";
import env from "../../env.js";
import {
  NOTIFICATION_DELIVERY_ATTEMPTS,
  type NotificationDeliveryJobData,
} from "../../jobs/notificationQueues.js";
import {
  startFakeSmtpServer,
  type FakeSmtpServer,
} from "../utils/fakeSmtpServer.js";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

// One attempt at a time, run here rather than by a worker: the job is a stub,
// and the rows are written directly, with no outbox row to dispatch them.

const rand = () => randomBytes(4).toString("hex");

let smtp: FakeSmtpServer;
let code = 250;
let connection: { id: string; slug: string };
const allowPrivateHosts = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;

const clean = async () => {
  await prisma.notificationDelivery.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.notificationConnection.deleteMany();
};

beforeAll(async () => {
  env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = true;
  await ensureDailyPartitions("notifications", 0, 1);
  await ensureDailyPartitions("notificationDeliveries", 0, 1);
  await ensureDefaultOrganization();
  smtp = await startFakeSmtpServer({ reply: () => code });
});

beforeEach(async () => {
  code = 250;
  smtp.messages.length = 0;
  await clean();
  connection = await prisma.notificationConnection.create({
    data: {
      channel: "email",
      slug: `c-${rand()}`,
      displayName: "Test",
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await smtp.close();
  await clean();
  env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = allowPrivateHosts;
});

/** A delivery as a stale sweep or earlier attempts left it. */
const seed = async (delivery: {
  status: "pending" | "sending";
  attempts: number;
  lastError?: string | null;
  connectionId?: string;
}) => {
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
          status: delivery.status,
          attempts: delivery.attempts,
          lastError: delivery.lastError ?? null,
          connectionId: delivery.connectionId ?? null,
        },
      ]
    )
  );
  const row = await prisma.notificationDelivery.findFirstOrThrow({
    where: { notificationId: notification.id },
  });
  return { notification, delivery: row };
};

/** A fresh job, as the stale sweep or a retry queues one. */
const jobFor = (seeded: Awaited<ReturnType<typeof seed>>) =>
  ({
    data: {
      deliveryId: seeded.delivery.id,
      notificationId: seeded.notification.id,
      notificationCreatedAt: seeded.notification.createdAt.toISOString(),
    },
    attemptsMade: 0,
    opts: { attempts: NOTIFICATION_DELIVERY_ATTEMPTS },
    moveToDelayed: vi.fn(),
    updateData: vi.fn(),
  }) as unknown as Job<NotificationDeliveryJobData>;

const reload = (id: string) =>
  prisma.notificationDelivery.findFirstOrThrow({ where: { id } });

/** The webhook events written for a notification, oldest first. */
const eventsFor = async (notificationId: string) =>
  (
    await prisma.outbox.findMany({
      where: { payload: { path: ["entityId"], equals: notificationId } },
      orderBy: { createdAt: "asc" },
    })
  ).map((row) => row.payload as { eventType: string; data: unknown });

describe("delivery attempt cap", () => {
  it("fails the delivery on its last attempt's failure", async () => {
    code = 451;
    const seeded = await seed({
      status: "pending",
      attempts: NOTIFICATION_DELIVERY_ATTEMPTS - 1,
    });
    await processNotificationDelivery(jobFor(seeded));

    const after = await reload(seeded.delivery.id);
    expect(after).toMatchObject({
      status: "failed",
      attempts: NOTIFICATION_DELIVERY_ATTEMPTS,
    });
    expect(after.lastError).toMatch(/451/);
    expect(
      (
        await prisma.notification.findFirstOrThrow({
          where: { id: seeded.notification.id },
        })
      ).status
    ).toBe("failed");
  });

  it("fails a delivery already at the cap without sending it again", async () => {
    const seeded = await seed({
      status: "pending",
      attempts: NOTIFICATION_DELIVERY_ATTEMPTS,
      lastError: "451 try later",
      connectionId: connection.id,
    });
    await processNotificationDelivery(jobFor(seeded));

    const after = await reload(seeded.delivery.id);
    expect(after).toMatchObject({
      status: "failed",
      attempts: NOTIFICATION_DELIVERY_ATTEMPTS,
      lastError: "451 try later",
    });
    expect(smtp.messages).toHaveLength(0);
    expect(
      (
        await prisma.notification.findFirstOrThrow({
          where: { id: seeded.notification.id },
        })
      ).status
    ).toBe("failed");
    expect(await eventsFor(seeded.notification.id)).toEqual(
      [
        {
          eventType: "notification.failed",
          data: expect.objectContaining({
            deliveryId: seeded.delivery.id,
            status: "failed",
            connection: connection.slug,
          }),
        },
      ].map((event) => expect.objectContaining(event))
    );
  });

  it("records attempts_exhausted when the capped delivery has no error yet", async () => {
    const seeded = await seed({
      status: "pending",
      attempts: NOTIFICATION_DELIVERY_ATTEMPTS,
    });
    await processNotificationDelivery(jobFor(seeded));

    const after = await reload(seeded.delivery.id);
    expect(after).toMatchObject({
      status: "failed",
      lastError: "attempts_exhausted",
    });
    expect(smtp.messages).toHaveLength(0);
    // No connection was ever used.
    expect(await eventsFor(seeded.notification.id)).toEqual([
      expect.objectContaining({
        eventType: "notification.failed",
        data: expect.objectContaining({ status: "failed", connection: null }),
      }),
    ]);
  });
});

describe("failure before the claim", () => {
  it("delays the job without spending an attempt, and sends on the next run", async () => {
    const seeded = await seed({ status: "pending", attempts: 0 });
    vi.spyOn(db.notifications, "markSending").mockRejectedValueOnce(
      new Error("connection terminated")
    );
    const job = jobFor(seeded);

    await expect(processNotificationDelivery(job)).rejects.toBeInstanceOf(
      DelayedError
    );
    expect(job.moveToDelayed).toHaveBeenCalledOnce();
    expect(await reload(seeded.delivery.id)).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    expect(smtp.messages).toHaveLength(0);

    await processNotificationDelivery(jobFor(seeded));
    expect(await reload(seeded.delivery.id)).toMatchObject({
      status: "sent",
      attempts: 1,
    });
    expect(smtp.messages).toHaveLength(1);
  });
});

describe("repeated failure before the claim", () => {
  it("spends an attempt once it has been delayed enough times", async () => {
    const seeded = await seed({ status: "pending", attempts: 0 });
    vi.spyOn(db.notifications, "markSending").mockRejectedValue(
      new Error("script error")
    );
    const job = jobFor(seeded);
    job.data.preClaimDelays = 10;

    await expect(processNotificationDelivery(job)).rejects.toThrow(
      "script error"
    );
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});

describe("send deadline", () => {
  const totalMs = smtpTimeouts.totalMs;
  let slow: FakeSmtpServer;

  beforeAll(async () => {
    slow = await startFakeSmtpServer({ delayMs: 2_000 });
  });

  afterAll(async () => {
    smtpTimeouts.totalMs = totalMs;
    await slow.close();
  });

  it("gives up on a send that outlasts it and leaves the delivery for a retry", async () => {
    smtpTimeouts.totalMs = 200;
    await prisma.notificationConnection.update({
      where: { id: connection.id },
      data: {
        settings: {
          host: "127.0.0.1",
          port: slow.port,
          security: "none",
          defaultFrom: { address: "billing@acme.com" },
          allowedSenders: ["@acme.com"],
        },
      },
    });
    const seeded = await seed({ status: "pending", attempts: 0 });

    await expect(processNotificationDelivery(jobFor(seeded))).rejects.toThrow(
      /did not finish/
    );

    expect(await reload(seeded.delivery.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: expect.stringMatching(/did not finish/),
    });
  });
});

describe("recording a sent delivery", () => {
  it("retries the write when the database fails after the send", async () => {
    const seeded = await seed({ status: "pending", attempts: 0 });
    const original = prisma.$transaction.bind(prisma);
    let failures = 2;
    vi.spyOn(prisma, "$transaction").mockImplementation(((
      ...args: unknown[]
    ) =>
      failures-- > 0
        ? Promise.reject(new Error("connection lost"))
        : (original as (...a: unknown[]) => unknown)(...args)) as never);

    await processNotificationDelivery(jobFor(seeded));

    expect(smtp.messages).toHaveLength(1);
    expect((await reload(seeded.delivery.id)).status).toBe("sent");
  });

  /** Runs `meanwhile` before the worker's first attempt to record the send. */
  const beforeRecording = (
    meanwhile: (deliveryId: string) => Promise<void>
  ) => {
    const markSent = db.notifications.markSent;
    let first = true;
    vi.spyOn(db.notifications, "markSent").mockImplementation((async (
      tx,
      ref,
      result,
      from
    ) => {
      if (first) {
        first = false;
        await meanwhile(ref.id);
      }
      return markSent(tx, ref, result, from);
    }) as typeof markSent);
  };

  it("records a send that outlived the stale sweep, so it isn't sent again", async () => {
    const seeded = await seed({ status: "pending", attempts: 0 });
    beforeRecording((id) =>
      prisma.notificationDelivery
        .updateMany({ where: { id }, data: { status: "pending" } })
        .then(() => undefined)
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    await processNotificationDelivery(jobFor(seeded));

    expect((await reload(seeded.delivery.id)).status).toBe("sent");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: seeded.delivery.id }),
      expect.stringMatching(/recorded as sent/)
    );
    // The re-queued job finds it settled and sends nothing.
    await processNotificationDelivery(jobFor(seeded));
    expect(smtp.messages).toHaveLength(1);
    expect(await eventsFor(seeded.notification.id)).toEqual([
      expect.objectContaining({ eventType: "notification.sent" }),
    ]);
  });

  it("warns when the re-queued job settled it first", async () => {
    const seeded = await seed({ status: "pending", attempts: 0 });
    beforeRecording((id) =>
      prisma.notificationDelivery
        .updateMany({ where: { id }, data: { status: "failed" } })
        .then(() => undefined)
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    await processNotificationDelivery(jobFor(seeded));

    expect((await reload(seeded.delivery.id)).status).toBe("failed");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: seeded.delivery.id,
        providerMessageId: `<${seeded.delivery.id}@acme.com>`,
      }),
      expect.stringMatching(/may be sent twice/)
    );
  });

  it("logs and rethrows when the write keeps failing", async () => {
    const seeded = await seed({ status: "pending", attempts: 0 });
    vi.spyOn(prisma, "$transaction").mockRejectedValue(
      new Error("connection lost")
    );
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    await expect(processNotificationDelivery(jobFor(seeded))).rejects.toThrow(
      "connection lost"
    );

    expect(smtp.messages).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: seeded.delivery.id,
        providerMessageId: `<${seeded.delivery.id}@acme.com>`,
      }),
      expect.any(String)
    );
    expect((await reload(seeded.delivery.id)).status).toBe("sending");
  });
});

describe("recording a failed delivery", () => {
  /** The stale sweep puts the delivery back to `pending` mid-send. */
  const resetBeforeRecording = () => {
    const markFailed = db.notifications.markFailed;
    let first = true;
    vi.spyOn(db.notifications, "markFailed").mockImplementation((async (
      tx,
      ref,
      lastError,
      from
    ) => {
      if (first) {
        first = false;
        await prisma.notificationDelivery.updateMany({
          where: { id: ref.id },
          data: { status: "pending" },
        });
      }
      return markFailed(tx, ref, lastError, from);
    }) as typeof markFailed);
  };

  it("records a permanent failure that outlived the stale sweep", async () => {
    code = 550;
    const seeded = await seed({ status: "pending", attempts: 0 });
    resetBeforeRecording();

    await processNotificationDelivery(jobFor(seeded));

    expect((await reload(seeded.delivery.id)).status).toBe("failed");
    const notification = await prisma.notification.findFirstOrThrow({
      where: { id: seeded.notification.id },
    });
    expect(notification.status).toBe("failed");
    expect(await eventsFor(seeded.notification.id)).toEqual([
      expect.objectContaining({ eventType: "notification.failed" }),
    ]);
  });

  it("records a last attempt's failure that outlived the stale sweep", async () => {
    code = 451;
    const seeded = await seed({
      status: "pending",
      attempts: NOTIFICATION_DELIVERY_ATTEMPTS - 1,
    });
    resetBeforeRecording();

    await processNotificationDelivery(jobFor(seeded));

    expect((await reload(seeded.delivery.id)).status).toBe("failed");
  });
});
