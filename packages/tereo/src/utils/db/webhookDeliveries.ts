import { Prisma } from "../../../prisma/generated/client/index.js";
import { runPartitionDdl } from "./partitionDdl.js";
import { GetPaginatedOptions } from "./types.js";
import { NotFoundError } from "../errors.js";
import { prisma } from "./prisma.js";

export interface CreateWebhookDeliveryInput {
  webhookEndpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface UpdateAttemptInput {
  attempts: number;
  lastAttemptAt: Date;
  httpStatus?: number | null;
  responseBody?: string | null;
  errorMessage?: string | null;
  status?: "PENDING" | "SUCCESS" | "FAILED";
  completedAt?: Date | null;
}

export interface BulkRetryFilters {
  createdAfter?: Date;
  createdBefore?: Date;
  eventType?: string;
  /** Leave `file-service.*` deliveries alone. */
  excludeFileEvents?: boolean;
  limit: number;
}

export interface DeliveryStats {
  /** The counts cover deliveries created in the last `windowDays` days. */
  windowDays: number;
  total: number;
  success: number;
  failed: number;
  pending: number;
  successRate: number;
  averageAttempts: number;
  last24Hours: {
    total: number;
    success: number;
    failed: number;
    pending: number;
  };
}

/**
 * A delivery's id, with its `createdAt` when the caller knows it: the table is
 * partitioned by `created_at`, so with it Postgres reads only the partition
 * holding the row instead of probing every partition's index.
 */
export interface DeliveryRef {
  id: string;
  createdAt?: Date;
}

const whereRef = ({ id, createdAt }: DeliveryRef) =>
  createdAt ? { id, createdAt } : { id };

/**
 * With `createdAt`, the lookup is pruned to one partition; a miss there falls
 * back to the id alone, so a wrong `createdAt` costs a query, never the row.
 */
export const findById = async (id: string, createdAt?: Date) => {
  if (createdAt) {
    const row = await prisma.webhookDelivery.findFirst({
      where: { id, createdAt },
    });
    if (row) return row;
  }
  return await prisma.webhookDelivery.findUnique({ where: { id } });
};

// Scoped to the owning endpoint so a caller can't read a delivery belonging to
// another endpoint (and another org) by pairing their own endpoint id with an
// arbitrary deliveryId. Does NOT include the endpoint relation — the prior
// `include: { webhookEndpoint: true }` leaked the endpoint's plaintext
// signingSecret into the response.
export const getForEndpoint = async (id: string, webhookEndpointId: string) => {
  const delivery = await prisma.webhookDelivery.findFirst({
    where: { id, webhookEndpointId },
  });
  if (!delivery) throw new NotFoundError("Webhook delivery not found");
  return delivery;
};

/** Which of `endpointIds` have at least one delivery row. */
export const endpointsWithDeliveries = async (
  endpointIds: string[]
): Promise<Set<string>> => {
  if (endpointIds.length === 0) return new Set();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT e.id::text AS id FROM unnest(${endpointIds}::uuid[]) AS e(id)
    WHERE EXISTS (
      SELECT 1 FROM "webhooks"."webhook_deliveries" d
      WHERE d."webhook_endpoint_id" = e.id
    )`;
  return new Set(rows.map((r) => r.id));
};

export const getPaginated = async (options: GetPaginatedOptions) => {
  const { take, orderBy, where: filterWhere } = options;
  const where = filterWhere ?? {};

  const rows = await prisma.webhookDelivery.findMany({
    where,
    take: take + 1,
    orderBy,
  });

  const hasMore = rows.length > take;
  const data = hasMore ? rows.slice(0, take) : rows;

  return { data, hasMore };
};

export const create = async (
  data: CreateWebhookDeliveryInput,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  return await db.webhookDelivery.create({
    data: {
      webhookEndpointId: data.webhookEndpointId,
      eventType: data.eventType,
      payload: data.payload as Prisma.InputJsonValue,
    },
  });
};

export const updateAttempt = async (
  delivery: DeliveryRef,
  data: UpdateAttemptInput,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  return await db.webhookDelivery.update({ where: whereRef(delivery), data });
};

/**
 * Record an attempt only while the delivery is still PENDING with the
 * attempts the caller read, so a stale or racing job neither reopens a
 * settled delivery nor overwrites another job's attempt. Returns whether
 * this call applied it: only then may the caller act on the outcome, e.g.
 * count a failure against the endpoint once.
 */
export const updateIfUnchanged = async (
  delivery: DeliveryRef,
  readAttempts: number,
  data: UpdateAttemptInput,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const db = tx ?? prisma;
  const result = await db.webhookDelivery.updateMany({
    where: { ...whereRef(delivery), status: "PENDING", attempts: readAttempts },
    data,
  });
  return result.count > 0;
};

const RETRY_RESET = {
  status: "PENDING",
  attempts: 0,
  lastAttemptAt: null,
  errorMessage: null,
  httpStatus: null,
  responseBody: null,
  completedAt: null,
} as const;

/**
 * Reset a FAILED delivery to PENDING. Returns the reset row, or null when the
 * delivery was not FAILED — conditional, so of two concurrent retries only one
 * resets it and enqueues a job.
 */
export const resetForRetry = async (
  delivery: DeliveryRef,
  webhookEndpointId: string,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  const result = await db.webhookDelivery.updateMany({
    where: { ...whereRef(delivery), webhookEndpointId, status: "FAILED" },
    data: RETRY_RESET,
  });
  if (result.count === 0) return null;
  return await db.webhookDelivery.findFirst({ where: whereRef(delivery) });
};

/**
 * Reset up to `limit` of an endpoint's FAILED deliveries, newest first, and
 * return the deliveries this call reset. Rows another retry holds are skipped,
 * so concurrent bulk retries never reset (and enqueue) the same delivery twice.
 */
export const bulkResetForRetry = async (
  webhookEndpointId: string,
  filters: BulkRetryFilters,
  tx?: Prisma.TransactionClient
): Promise<DeliveryCursor[]> => {
  const db = tx ?? prisma;
  const conditions = [
    Prisma.sql`"webhook_endpoint_id" = ${webhookEndpointId}::uuid`,
    Prisma.sql`"status" = 'FAILED'`,
  ];
  if (filters.createdAfter)
    conditions.push(Prisma.sql`"created_at" >= ${filters.createdAfter}`);
  if (filters.createdBefore)
    conditions.push(Prisma.sql`"created_at" <= ${filters.createdBefore}`);
  if (filters.eventType)
    conditions.push(Prisma.sql`"event_type" = ${filters.eventType}`);
  if (filters.excludeFileEvents)
    conditions.push(Prisma.sql`"event_type" NOT LIKE 'file-service.%'`);

  return await db.$queryRaw<DeliveryCursor[]>`
    UPDATE "webhooks"."webhook_deliveries" d
    SET "status" = 'PENDING', "attempts" = 0, "last_attempt_at" = NULL,
        "error_message" = NULL,
        "http_status" = NULL, "response_body" = NULL, "completed_at" = NULL,
        "updated_at" = NOW()
    WHERE d."status" = 'FAILED' AND d."id" IN (
      SELECT "id" FROM "webhooks"."webhook_deliveries"
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY "created_at" DESC
      LIMIT ${filters.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING d."id"::text AS id, d."created_at" AS "createdAt"`;
};

export interface DeliveryCursor {
  id: string;
  createdAt: Date;
}

/**
 * PENDING deliveries that look jobless, in (created_at, id) order after
 * `after`: never attempted and untouched since `updatedBefore`, or last
 * attempted before `attemptedBefore`.
 */
export const findStalePending = async (options: {
  updatedBefore: Date;
  attemptedBefore: Date;
  after?: DeliveryCursor;
  limit: number;
}): Promise<DeliveryCursor[]> => {
  const after = options.after
    ? Prisma.sql`AND ("created_at", "id") > (${options.after.createdAt}, ${options.after.id}::uuid)`
    : Prisma.empty;
  // No bound on created_at: a retry makes a delivery of any age PENDING again.
  // Each partition is read through its status index, and few rows are PENDING.
  return await prisma.$queryRaw<DeliveryCursor[]>`
    SELECT "id"::text AS id, "created_at" AS "createdAt"
    FROM "webhooks"."webhook_deliveries"
    WHERE "status" = 'PENDING'
      AND (
        ("last_attempt_at" IS NULL AND "updated_at" < ${options.updatedBefore})
        OR "last_attempt_at" < ${options.attemptedBefore}
      )
      ${after}
    ORDER BY "created_at", "id"
    LIMIT ${options.limit}`;
};

/** How far back the stats look: a bounded range of partitions, not all 90 days. */
const STATS_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type StatusCounts = { success: number; failed: number; pending: number };

const countByStatus = async (webhookEndpointId: string, since: Date) => {
  const rows = await prisma.webhookDelivery.groupBy({
    by: ["status"],
    where: { webhookEndpointId, createdAt: { gte: since } },
    _count: { _all: true },
    _sum: { attempts: true },
  });
  const counts: StatusCounts = { success: 0, failed: 0, pending: 0 };
  let completedAttempts = 0;
  for (const row of rows) {
    const key = row.status.toLowerCase() as keyof StatusCounts;
    counts[key] = row._count._all;
    if (row.status !== "PENDING") completedAttempts += row._sum.attempts ?? 0;
  }
  return { counts, completedAttempts };
};

/**
 * Counts of the endpoint's deliveries created in the last
 * `STATS_WINDOW_DAYS` days, and in the last 24 hours. A SUCCESS or FAILED
 * delivery is the completed one `successRate` and `averageAttempts` cover.
 */
export const getStats = async (
  webhookEndpointId: string
): Promise<DeliveryStats> => {
  const now = Date.now();
  const [window, day] = await Promise.all([
    countByStatus(
      webhookEndpointId,
      new Date(now - STATS_WINDOW_DAYS * DAY_MS)
    ),
    countByStatus(webhookEndpointId, new Date(now - DAY_MS)),
  ]);

  const { success, failed, pending } = window.counts;
  const completed = success + failed;
  const successRate =
    completed > 0 ? Math.round((success / completed) * 1000) / 1000 : 0;
  const averageAttempts =
    completed > 0 ? window.completedAttempts / completed : 0;
  const total = (c: StatusCounts) => c.success + c.failed + c.pending;

  return {
    windowDays: STATS_WINDOW_DAYS,
    total: total(window.counts),
    success,
    failed,
    pending,
    successRate,
    averageAttempts: Math.round(averageAttempts * 10) / 10,
    last24Hours: { total: total(day.counts), ...day.counts },
  };
};

export const listPartitions = async () => {
  return await prisma.$queryRaw<{ child: string }[]>`
    SELECT c.relname AS child
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'webhooks' AND p.relname = 'webhook_deliveries'
    ORDER BY c.relname
  `;
};

// Names and dates are interpolated into DDL, so both are validated first.
const PARTITION_NAME_RE = /^webhook_deliveries_\d{4}_\d{2}_\d{2}$/;
const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;

function validatePartitionName(name: string): void {
  if (!PARTITION_NAME_RE.test(name)) {
    throw new Error(`Invalid partition name: ${name}`);
  }
}

function validateDateStr(date: string): void {
  if (!DATE_STR_RE.test(date)) {
    throw new Error(`Invalid date string: ${date}`);
  }
}

/** False when the parent stayed locked; the partition is left for next time. */
export const dropPartition = async (partitionName: string) => {
  validatePartitionName(partitionName);
  return await runPartitionDdl([
    `DROP TABLE IF EXISTS "webhooks"."${partitionName}"`,
  ]);
};

/** False when the parent stayed locked; nothing is created. */
export const createPartition = async (
  name: string,
  from: string,
  to: string
) => {
  validatePartitionName(name);
  validateDateStr(from);
  validateDateStr(to);
  return await runPartitionDdl([
    `CREATE TABLE IF NOT EXISTS "webhooks"."${name}" PARTITION OF "webhooks"."webhook_deliveries" FOR VALUES FROM ('${from}') TO ('${to}')`,
  ]);
};
