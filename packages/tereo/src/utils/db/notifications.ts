import { Prisma } from "../../../prisma/generated/client/index.js";
import { runPartitionDdl } from "./partitionDdl.js";
import { userRefSelect } from "../refs.js";
import { prisma } from "./prisma.js";

type Tx = Prisma.TransactionClient;

export type NewDelivery = Omit<
  Prisma.NotificationDeliveryUncheckedCreateInput,
  "notificationId" | "notificationCreatedAt"
>;

/** The notification and its deliveries, which share its partition day. */
export const insert = async (
  tx: Tx,
  notification: Prisma.NotificationUncheckedCreateInput,
  deliveries: NewDelivery[]
) => {
  const row = await tx.notification.create({ data: notification });
  await tx.notificationDelivery.createMany({
    data: deliveries.map((d) => ({
      ...d,
      notificationId: row.id,
      notificationCreatedAt: row.createdAt,
    })),
  });
  return row;
};

/** `createdAt`, when known, keeps the lookup to one partition. */
export const get = (id: string, createdAt?: Date) =>
  prisma.notification.findFirst({
    where: { id, ...(createdAt && { createdAt }) },
  });

export const getWithDeliveries = (id: string) =>
  prisma.notification.findFirst({
    where: { id },
    include: {
      deliveries: { orderBy: { createdAt: "asc" } },
      sender: userRefSelect,
    },
  });

export interface ListOptions {
  take: number;
  orderBy: Prisma.NotificationOrderByWithRelationInput[];
  where?: Prisma.NotificationWhereInput;
}

/**
 * One page of the log, newest first; `content` stays out of lists. `sentAt`
 * is the latest delivery's, null until one is sent.
 */
export const list = async (options: ListOptions) => {
  const rows = await prisma.notification.findMany({
    take: options.take + 1,
    orderBy: options.orderBy,
    where: options.where,
    omit: { content: true, senderAccess: true },
    include: {
      deliveries: {
        select: { sentAt: true },
        orderBy: { sentAt: { sort: "desc", nulls: "last" } },
        take: 1,
      },
      sender: userRefSelect,
    },
  });
  const hasMore = rows.length > options.take;
  const page = hasMore ? rows.slice(0, options.take) : rows;
  return {
    data: page.map(({ deliveries, ...row }) => ({
      ...row,
      sentAt: deliveries[0]?.sentAt ?? null,
    })),
    hasMore,
  };
};

/**
 * Put a notification's `failed` deliveries back to `pending` with a fresh
 * attempt count, re-roll its status, and queue it for dispatch, all in `tx`.
 * Returns how many were reset; none leaves everything untouched.
 */
export const requeueFailed = async (tx: Tx, id: string, createdAt: Date) => {
  const { count } = await tx.notificationDelivery.updateMany({
    where: {
      notificationId: id,
      notificationCreatedAt: createdAt,
      status: "failed",
    },
    data: { status: "pending", attempts: 0 },
  });
  if (count > 0) await rollUp(tx, id, createdAt);
  return count;
};

export type NotificationPartitionTable =
  "notifications" | "notificationDeliveries";

const PARTITIONED = {
  notifications: { parent: "notifications", prefix: "notifications" },
  notificationDeliveries: { parent: "deliveries", prefix: "deliveries" },
} as const;

// Names and dates are interpolated into DDL, so both are validated first.
const PARTITION_NAME_RE = /^(notifications|deliveries)_\d{4}_\d{2}_\d{2}$/;
const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;

function validatePartitionName(name: string, prefix?: string): void {
  if (
    !PARTITION_NAME_RE.test(name) ||
    (prefix && !name.startsWith(`${prefix}_`))
  ) {
    throw new Error(`Invalid partition name: ${name}`);
  }
}

function validateDateStr(date: string): void {
  if (!DATE_STR_RE.test(date)) {
    throw new Error(`Invalid date string: ${date}`);
  }
}

/** False when the parent stayed locked; nothing is created. */
const createPartition = async (
  table: NotificationPartitionTable,
  name: string,
  from: string,
  to: string
) => {
  const { parent, prefix } = PARTITIONED[table];
  validatePartitionName(name, prefix);
  validateDateStr(from);
  validateDateStr(to);
  return await runPartitionDdl([
    `CREATE TABLE IF NOT EXISTS "notifications"."${name}" PARTITION OF "notifications"."${parent}" FOR VALUES FROM ('${from}') TO ('${to}')`,
  ]);
};

export const createNotificationsPartition = (
  name: string,
  from: string,
  to: string
) => createPartition("notifications", name, from, to);

export const createDeliveriesPartition = (
  name: string,
  from: string,
  to: string
) => createPartition("notificationDeliveries", name, from, to);

export const listPartitions = async (table: NotificationPartitionTable) =>
  await prisma.$queryRaw<{ child: string }[]>`
    SELECT c.relname AS child
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'notifications' AND p.relname = ${PARTITIONED[table].parent}
    ORDER BY c.relname
  `;

/**
 * Tables named like `table`'s partitions but attached to nothing: left behind
 * by a drop that detached them and then failed before dropping them.
 */
export const listDetachedPartitions = async (
  table: NotificationPartitionTable
) =>
  await prisma.$queryRaw<{ child: string }[]>`
    SELECT c.relname AS child
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'notifications'
      AND c.relkind = 'r'
      AND NOT c.relispartition
      AND c.relname ~ ('^' || ${PARTITIONED[table].prefix} || '_[0-9]{4}_[0-9]{2}_[0-9]{2}$')
    ORDER BY c.relname
  `;

/**
 * Detaches and drops one partition, or drops a detached one, in one
 * transaction. False when the parent stayed locked; it is left for next time.
 */
export const dropPartition = async (
  table: NotificationPartitionTable,
  name: string
) => {
  const { parent, prefix } = PARTITIONED[table];
  validatePartitionName(name, prefix);
  // Postgres refuses to drop a partition the deliveries foreign key references
  // while it is attached; detached, it is an ordinary table.
  const attached = await prisma.$queryRaw<{ one: number }[]>`
    SELECT 1 AS one
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'notifications' AND c.relname = ${name} AND p.relname = ${parent}
  `;
  return await runPartitionDdl([
    ...(attached.length > 0
      ? [
          `ALTER TABLE "notifications"."${parent}" DETACH PARTITION "notifications"."${name}"`,
        ]
      : []),
    `DROP TABLE IF EXISTS "notifications"."${name}"`,
  ]);
};

// ===========================================================================
// Delivery
// ===========================================================================

/** A delivery's primary key: its id and its notification's partition day. */
export interface DeliveryRef {
  id: string;
  notificationCreatedAt: Date;
}

const deliveryKey = (ref: DeliveryRef) => ({
  id: ref.id,
  notificationCreatedAt: ref.notificationCreatedAt,
});

export const getDelivery = (ref: DeliveryRef) =>
  prisma.notificationDelivery.findFirst({ where: deliveryKey(ref) });

/** Pending deliveries of one notification, which dispatch queues. */
export const pendingDeliveries = (id: string, createdAt: Date) =>
  prisma.notificationDelivery.findMany({
    where: {
      notificationId: id,
      notificationCreatedAt: createdAt,
      status: "pending",
    },
    select: { id: true, notificationId: true, notificationCreatedAt: true },
  });

/**
 * Claim a pending delivery for one attempt, through `connectionId`. False when
 * it was not pending: another job has it, or it has settled.
 */
export const markSending = async (ref: DeliveryRef, connectionId: string) => {
  const { count } = await prisma.notificationDelivery.updateMany({
    where: { ...deliveryKey(ref), status: "pending" },
    data: { status: "sending", connectionId, attempts: { increment: 1 } },
  });
  return count === 1;
};

// The settling writes apply only to the status they expect, so a late writer
// (a worker whose delivery the stale sweep or a retry has since reset) changes
// nothing. Each returns `{ count }`; 0 means it was not applied.

/**
 * `from`: `pending` only for a send that outlived the stale sweep, which put
 * its delivery back before the worker could record it.
 */
export const markSent = (
  tx: Tx,
  ref: DeliveryRef,
  result: { providerMessageId: string | null; providerResponse: string | null },
  from: "sending" | "pending" = "sending"
) =>
  tx.notificationDelivery.updateMany({
    where: { ...deliveryKey(ref), status: from },
    data: {
      status: "sent",
      lastError: null,
      providerMessageId: result.providerMessageId?.slice(0, 255) ?? null,
      providerResponse: result.providerResponse?.slice(0, 4096) ?? null,
      sentAt: new Date(),
    },
  });

/**
 * `from`: `pending` only for a delivery failed without an attempt, or for a
 * failed send that outlived the stale sweep.
 */
export const markFailed = (
  tx: Tx,
  ref: DeliveryRef,
  lastError: string,
  from: "sending" | "pending" = "sending"
) =>
  tx.notificationDelivery.updateMany({
    where: { ...deliveryKey(ref), status: from },
    data: { status: "failed", lastError: lastError.slice(0, 2048) },
  });

/**
 * Back to `pending` after a failed attempt (`from: "sending"`), or kept there
 * while it waits for a connection (`from: "pending"`).
 */
export const markPending = (
  ref: DeliveryRef,
  lastError: string,
  from: "sending" | "pending"
) =>
  prisma.notificationDelivery.updateMany({
    where: { ...deliveryKey(ref), status: from },
    data: { status: "pending", lastError: lastError.slice(0, 2048) },
  });

/**
 * Set the notification's status from its deliveries': `sent` or `failed` when
 * all are, `partial` when settled both ways, else `pending`. Its content is
 * dropped once every delivery is sent; until then a retry may need it. Run
 * in the transaction that settled the delivery.
 */
export const rollUp = async (tx: Tx, id: string, createdAt: Date) => {
  // Deliveries settling at once each see the other's uncommitted status;
  // locking the notification makes the second wait and read the first's.
  await tx.$executeRaw`
    SELECT 1 FROM "notifications"."notifications"
    WHERE "id" = ${id}::uuid AND "created_at" = ${createdAt}
    FOR UPDATE`;
  const deliveries = await tx.notificationDelivery.findMany({
    where: { notificationId: id, notificationCreatedAt: createdAt },
    select: { status: true },
  });
  const count = (status: string) =>
    deliveries.filter((d) => d.status === status).length;
  const sent = count("sent");
  const failed = count("failed");
  const status =
    sent === deliveries.length
      ? "sent"
      : failed === deliveries.length
        ? "failed"
        : sent + failed === deliveries.length
          ? "partial"
          : "pending";
  await tx.notification.updateMany({
    where: { id, createdAt },
    data: {
      status,
      ...(status === "sent" && { content: Prisma.DbNull }),
    },
  });
  return status;
};

/**
 * Deliveries left `sending` since before `olderThan`: their worker died
 * mid-send. Each is put back to `pending` while it still is stale, so a sweep
 * racing a late `markSent` changes nothing. Returns those it put back.
 */
export const resetStaleSending = async (
  olderThan: Date,
  createdAfter: Date
): Promise<DeliveryRef[]> =>
  prisma.$queryRaw<DeliveryRef[]>`
    UPDATE "notifications"."deliveries"
    SET "status" = 'pending', "updated_at" = NOW()
    WHERE "status" = 'sending'
      AND "updated_at" < ${olderThan}
      AND "notification_created_at" >= ${createdAfter}
    RETURNING "id", "notification_created_at" AS "notificationCreatedAt"`;

/**
 * Deliveries `pending` since before `olderThan`, oldest first, from after
 * `after` (the last row of the previous page). One whose job was lost (a
 * failed enqueue, a removed job) would otherwise wait forever; the sweep
 * queues them again, which is a no-op for those with a live job.
 */
export const stalePending = (
  olderThan: Date,
  createdAfter: Date,
  limit: number,
  after?: { updatedAt: Date; id: string }
): Promise<(DeliveryRef & { updatedAt: Date })[]> =>
  prisma.$queryRaw<(DeliveryRef & { updatedAt: Date })[]>`
    SELECT "id", "notification_created_at" AS "notificationCreatedAt",
           "updated_at" AS "updatedAt"
    FROM "notifications"."deliveries"
    WHERE "status" = 'pending'
      AND "updated_at" < ${olderThan}
      AND "notification_created_at" >= ${createdAfter}
      ${
        after
          ? Prisma.sql`AND ("updated_at", "id") > (${after.updatedAt}, ${after.id}::uuid)`
          : Prisma.empty
      }
    ORDER BY "updated_at", "id"
    LIMIT ${limit}`;
