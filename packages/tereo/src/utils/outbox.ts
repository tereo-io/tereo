import { getRequestId, getRequestIpAddress } from "./requestId.js";
import type { Prisma } from "./db/prisma.js";
import { randomUUID } from "node:crypto";
import { prisma } from "./db/prisma.js";
import { logger } from "./logger.js";
import {
  acceptNotification,
  type NotificationInput,
} from "./notifications/accept.js";
import {
  CORE_SOURCE,
  EVENT_TYPES,
  RESERVED_EVENT_TYPES,
  SYSTEM_USER_ID,
} from "../definitions/index.js";
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";

/**
 * Audit entries and webhook events, written in the caller's transaction.
 *
 * - `logAuditTx` inserts the audit entry directly — the audit table is in the
 *   same database, so it commits or rolls back with the business write.
 * - `emitTx` writes a row to `core.outbox`. Webhook fan-out enqueues BullMQ
 *   jobs in Redis, which cannot join a Postgres transaction, so the outbox
 *   reaper (`createOutboxReaper`, run by the worker) dispatches it after
 *   commit, with the row id as the idempotency key.
 */

type Tx = Prisma.TransactionClient;

// ===========================================================================
// Audit
// ===========================================================================

export interface AuditLogInput {
  /**
   * The actor. A request's `AuthContext` also carries the token's client and,
   * for a token delegated to a third-party client, its ceiling.
   */
  auth: {
    userId: string;
    email: string | null;
    clientId?: string;
    ceiling?: string[];
  };
  organizationId?: string | null;
  action:
    | "CREATE"
    | "UPDATE"
    | "DELETE"
    | "MERGE"
    | "ARCHIVE"
    | "RESTORE"
    | "LOGIN"
    | "LOGOUT";
  entityType: string;
  entityId: string;
  entityName?: string;
  changes?: Record<string, { old: unknown; new: unknown }>;
  metadata?: Record<string, unknown>;
  correlationId?: string;
}

/**
 * Record an audit entry inside a Prisma transaction. The writer is core's
 * system user: this entry was written in-process, not by an authenticated
 * caller of the audit API.
 */
export async function logAuditTx(tx: Tx, input: AuditLogInput): Promise<void> {
  const ip = getRequestIpAddress();
  await tx.auditLogEntry.create({
    data: {
      source: CORE_SOURCE,
      organizationId: input.organizationId ?? null,
      userId: input.auth.userId,
      userEmail: input.auth.email?.toLowerCase() ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      entityName: input.entityName,
      changes: input.changes as Prisma.InputJsonValue | undefined,
      metadata: auditMetadata(input) as Prisma.InputJsonValue | undefined,
      ipAddress: ip === "unknown" ? null : ip,
      correlationId: input.correlationId ?? getRequestId(),
      writerUserId: SYSTEM_USER_ID,
    },
  });
}

// A delegated token acts for its user through a third-party client, which
// the entry names: the user alone would read as the user's own doing.
const auditMetadata = ({
  auth,
  metadata,
}: AuditLogInput): Record<string, unknown> | undefined =>
  auth.ceiling && auth.clientId
    ? { clientId: auth.clientId, ...metadata }
    : metadata;

/**
 * Deep equality comparison for computing field-level diffs.
 * Handles primitives, Date objects, arrays, and nested plain objects.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
      if (!deepEqual(aObj[key], bObj[key])) return false;
    }
    return true;
  }

  return false;
}

/**
 * Field-level diff for an audit entry's `changes`. Skips `createdAt`,
 * `updatedAt`, `deletedAt`, `archivedAt`. Returns `undefined` if nothing
 * changed.
 */
export function computeChanges(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>
): Record<string, { old: unknown; new: unknown }> | undefined {
  const changes: Record<string, { old: unknown; new: unknown }> = {};

  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

  for (const key of allKeys) {
    if (["createdAt", "updatedAt", "deletedAt", "archivedAt"].includes(key))
      continue;

    const oldVal = oldObj[key];
    const newVal = newObj[key];

    if (!deepEqual(oldVal, newVal)) {
      changes[key] = { old: oldVal, new: newVal };
    }
  }

  return Object.keys(changes).length > 0 ? changes : undefined;
}

// ===========================================================================
// Webhook events
// ===========================================================================

export interface EmitTxInput {
  /**
   * Null for a resource outside any organization (an app service's declared
   * bucket): sent only to endpoints of all organizations and to `serviceId`'s.
   */
  organizationId: string | null;
  /** The service whose resource this is; used only without an organization. */
  serviceId?: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  data: Record<string, unknown>;
  /** Slugs of services or integrations: sent only to endpoints they own. */
  recipients?: string[];
}

/** Where a bucket's events go: its organization, or its service's endpoints. */
export const bucketEventScope = (bucket: {
  organizationId: string | null;
  serviceId: string | null;
}): Pick<EmitTxInput, "organizationId" | "serviceId"> =>
  bucket.organizationId
    ? { organizationId: bucket.organizationId }
    : { organizationId: null, serviceId: bucket.serviceId };

const KNOWN_EVENT_TYPES = new Set(EVENT_TYPES.map((e) => e.eventType));

/**
 * Enqueue a webhook event inside a Prisma transaction. The event type must be
 * in `definitions/eventTypes.ts`, so a typo fails at the request instead of
 * dead-lettering later.
 */
export async function emitTx(tx: Tx, event: EmitTxInput): Promise<void> {
  if (!KNOWN_EVENT_TYPES.has(event.eventType)) {
    throw new Error(
      `Unknown webhook event type "${event.eventType}" — add it to definitions/eventTypes.ts`
    );
  }
  if (RESERVED_EVENT_TYPES.has(event.eventType)) {
    throw new Error(`Reserved webhook event type "${event.eventType}"`);
  }
  const trace = captureTraceContext();
  await tx.outbox.create({
    data: {
      destination: "webhook",
      payload: event as unknown as Prisma.InputJsonValue,
      traceparent: trace.traceparent,
      tracestate: trace.tracestate,
    },
  });
}

// ===========================================================================
// Notifications
// ===========================================================================

/**
 * Queue an accepted notification for delivery: the reaper's `notification`
 * dispatcher enqueues its deliveries after commit.
 */
export async function enqueueNotificationTx(
  tx: Tx,
  notification: { id: string; createdAt: Date }
): Promise<void> {
  const trace = captureTraceContext();
  await tx.outbox.create({
    data: {
      destination: "notification",
      payload: {
        notificationId: notification.id,
        createdAt: notification.createdAt.toISOString(),
      },
      traceparent: trace.traceparent,
      tracestate: trace.tracestate,
    },
  });
}

/**
 * Send a notification as core, inside the caller's transaction: the same
 * checks and write as `POST /v1/notifications`, with every bucket readable.
 * Nothing is sent unless the transaction commits.
 */
export async function notifyTx(
  tx: Tx,
  input: NotificationInput
): Promise<{ id: string }> {
  const { id } = await acceptNotification(
    tx,
    { userId: SYSTEM_USER_ID, email: null, auth: "system" },
    input
  );
  return { id };
}

// ===========================================================================
// Reaper
// ===========================================================================

const tracer = trace.getTracer("tereo/outbox");

/**
 * Capture the active trace context as a W3C `traceparent` (and optional
 * `tracestate`) so the reaper can re-inject it at dispatch time. Returns an
 * empty pair when no trace context is active.
 */
const captureTraceContext = (): {
  traceparent: string | null;
  tracestate: string | null;
} => {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return {
    traceparent: carrier.traceparent ?? null,
    tracestate: carrier.tracestate ?? null,
  };
};

/** Row shape returned by `$queryRaw` from `core.outbox`. */
export interface OutboxRow {
  id: string;
  destination: string;
  payload: unknown;
  traceparent: string | null;
  tracestate: string | null;
  created_at: Date;
  next_attempt_at: Date;
  claimed_at: Date | null;
  claimed_by: string | null;
  attempts: number;
  last_error: string | null;
  dead_lettered_at: Date | null;
}

/**
 * Thrown by a dispatcher for a row that can never succeed (a malformed
 * payload, a rejected event): the reaper dead-letters it at once instead of
 * retrying it for hours.
 */
export class PermanentDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentDispatchError";
  }
}

/** Dispatcher invoked by the reaper. Throw to mark the row failed. */
export type OutboxDispatcher = (
  payload: unknown,
  row: OutboxRow
) => Promise<void>;

export interface OutboxReaperOptions {
  /** `destination` → handler. A row with no handler is dead-lettered. */
  dispatchers: Record<string, OutboxDispatcher>;
  /** Populates `claimed_by`. Defaults to a random uuid. */
  workerId?: string;
  pollIntervalMs?: number;
  batchSize?: number;
  /** After this many attempts the row is dead-lettered and kept for replay. */
  maxAttempts?: number;
  retryBaseMs?: number;
  maxBackoffMs?: number;
  /** A claim older than this may be re-claimed by another worker. */
  claimTtlMs?: number;
  /**
   * Rows of a batch dispatched at once. Each dispatch holds database
   * connections from the pool API requests share, so this stays well under it.
   */
  dispatchConcurrency?: number;
}

export interface OutboxReaper {
  start: () => void;
  stop: () => Promise<void>;
}

const restoreTraceContext = (row: OutboxRow) => {
  if (!row.traceparent) return context.active();
  const carrier: Record<string, string> = { traceparent: row.traceparent };
  if (row.tracestate) carrier.tracestate = row.tracestate;
  return propagation.extract(context.active(), carrier);
};

const computeNextAttemptAt = (
  attempts: number,
  baseMs: number,
  maxBackoffMs: number
): Date => {
  const exp = Math.min(baseMs * Math.pow(2, attempts), maxBackoffMs);
  // Full jitter: pick uniformly in [0, exp). Avoids retry stampedes under
  // simultaneous failure of many in-flight rows.
  return new Date(Date.now() + Math.floor(Math.random() * exp));
};

/**
 * Dead-letters emit a structured `outbox.dead_letter` log line; the row
 * itself is kept with `dead_lettered_at` set, for `npm run cli --
 * outbox-replay`, until the retention sweep (`jobs/outboxRetention.ts`)
 * deletes it.
 */
const logDeadLetter = (row: OutboxRow, lastError: string): void => {
  logger.error(
    {
      event: "outbox.dead_letter",
      outboxId: row.id,
      destination: row.destination,
      attempts: row.attempts,
      createdAt: row.created_at.toISOString(),
      claimedBy: row.claimed_by,
      lastError,
      payload: row.payload,
    },
    "outbox.dead_letter"
  );
};

/**
 * Poll `core.outbox` and dispatch claimed rows. Rows are claimed with
 * `FOR UPDATE SKIP LOCKED`, so any number of workers can run one. Successful
 * rows are deleted; failures back off exponentially with full jitter.
 */
export const createOutboxReaper = (
  options: OutboxReaperOptions
): OutboxReaper => {
  const {
    dispatchers,
    workerId = randomUUID(),
    pollIntervalMs = 1000,
    batchSize = 100,
    // 100 attempts × 30 min cap × full jitter ≈ 12 hours of retry runway.
    maxAttempts = 100,
    retryBaseMs = 2000,
    maxBackoffMs = 30 * 60 * 1000,
    claimTtlMs = 60_000,
    dispatchConcurrency = 10,
  } = options;

  let running = false;
  let stopRequested = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  // Staleness is judged by the database's clock, which wrote `claimed_at`.
  const claimBatch = async (): Promise<OutboxRow[]> => {
    return prisma.$queryRaw<OutboxRow[]>`
      UPDATE "core"."outbox" o
      SET claimed_at = NOW(), claimed_by = ${workerId}
      WHERE o.id IN (
        SELECT id FROM "core"."outbox"
        WHERE next_attempt_at <= NOW()
          AND dead_lettered_at IS NULL
          AND (
            claimed_at IS NULL
            OR claimed_at < NOW() - ${claimTtlMs}::int * INTERVAL '1 millisecond'
          )
        ORDER BY next_attempt_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING o.*;
    `;
  };

  // The writes below touch the row only while this worker still holds its
  // claim: a dispatch that outlived the claim TTL leaves the row to whichever
  // worker re-claimed it. Each returns whether it wrote.
  const deleteRow = async (id: string): Promise<boolean> =>
    (await prisma.$executeRaw`
      DELETE FROM "core"."outbox"
      WHERE id = ${id}::uuid AND claimed_by = ${workerId};
    `) > 0;

  const markDeadLettered = async (
    id: string,
    attempts: number,
    error: string
  ): Promise<boolean> =>
    (await prisma.$executeRaw`
      UPDATE "core"."outbox"
      SET attempts = ${attempts},
          last_error = ${error.slice(0, 1000)},
          dead_lettered_at = NOW(),
          claimed_at = NULL
      WHERE id = ${id}::uuid AND claimed_by = ${workerId};
    `) > 0;

  const markFailed = async (
    id: string,
    attempts: number,
    error: string,
    nextAttemptAt: Date
  ): Promise<boolean> =>
    (await prisma.$executeRaw`
      UPDATE "core"."outbox"
      SET attempts = ${attempts},
          last_error = ${error.slice(0, 1000)},
          next_attempt_at = ${nextAttemptAt},
          claimed_at = NULL
      WHERE id = ${id}::uuid AND claimed_by = ${workerId};
    `) > 0;

  /**
   * Renews the claim on `id` just before it is dispatched. The batch is
   * claimed at once but dispatched a few rows at a time, so a row near the
   * end of a slow batch could outlive the claim TTL and be claimed (and
   * dispatched) by another worker as well; false when that already happened.
   */
  const renewClaim = async (id: string): Promise<boolean> =>
    (await prisma.$executeRaw`
      UPDATE "core"."outbox"
      SET claimed_at = NOW()
      WHERE id = ${id}::uuid AND claimed_by = ${workerId};
    `) > 0;

  const logLostClaim = (row: OutboxRow): void => {
    logger.warn(
      { outboxId: row.id, destination: row.destination, workerId },
      "Outbox row re-claimed by another worker; leaving it to them"
    );
  };

  const processRow = async (row: OutboxRow): Promise<void> => {
    const nextAttempts = row.attempts + 1;
    const dispatcher = dispatchers[row.destination];

    if (!dispatcher) {
      const message = `No dispatcher registered for destination "${row.destination}"`;
      logDeadLetter(row, message);
      if (!(await markDeadLettered(row.id, nextAttempts, message))) {
        logLostClaim(row);
      }
      return;
    }

    // Dispatch under the originating request's trace, so the delivery chains
    // off the user action that caused it.
    await context.with(restoreTraceContext(row), () =>
      tracer.startActiveSpan(
        `outbox.dispatch ${row.destination}`,
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            "outbox.id": row.id,
            "outbox.destination": row.destination,
            "outbox.attempts": nextAttempts,
            "outbox.queue_time_ms": Date.now() - row.created_at.getTime(),
          },
        },
        async (span) => {
          try {
            await dispatcher(row.payload, row);
            if (!(await deleteRow(row.id))) logLostClaim(row);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            span.recordException(
              err instanceof Error ? err : new Error(message)
            );
            span.setStatus({ code: SpanStatusCode.ERROR, message });

            if (
              err instanceof PermanentDispatchError ||
              nextAttempts >= maxAttempts
            ) {
              logDeadLetter(row, message);
              if (!(await markDeadLettered(row.id, nextAttempts, message))) {
                logLostClaim(row);
              }
              return;
            }

            const nextAttemptAt = computeNextAttemptAt(
              nextAttempts,
              retryBaseMs,
              maxBackoffMs
            );
            logger.warn(
              {
                outboxId: row.id,
                destination: row.destination,
                attempts: nextAttempts,
                nextAttemptAt: nextAttemptAt.toISOString(),
                err,
              },
              "Outbox row failed; will retry"
            );
            if (
              !(await markFailed(row.id, nextAttempts, message, nextAttemptAt))
            ) {
              logLostClaim(row);
            }
          } finally {
            span.end();
          }
        }
      )
    );
  };

  const tick = async (): Promise<void> => {
    let rows: OutboxRow[];
    try {
      rows = await claimBatch();
    } catch (err) {
      logger.error({ err }, "Outbox reaper claim failed");
      return;
    }
    // Each dispatch is I/O-bound and independent of the rest of the batch;
    // `dispatchConcurrency` lanes take the batch's rows in turn.
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < rows.length) {
        const row = rows[next++];
        await (async () => {
          if (!(await renewClaim(row.id))) return logLostClaim(row);
          await processRow(row);
        })().catch((err) => {
          logger.error(
            { err, outboxId: row.id },
            "Outbox row dispatch threw unexpectedly"
          );
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(dispatchConcurrency, rows.length) }, lane)
    );
  };

  const loop = async (): Promise<void> => {
    while (!stopRequested) {
      inFlight = tick().catch((err) => {
        logger.error({ err }, "Outbox reaper tick threw unexpectedly");
      });
      await inFlight;
      inFlight = null;
      if (stopRequested) break;
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, pollIntervalMs);
      });
      timer = null;
    }
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      stopRequested = false;
      logger.info(
        {
          workerId,
          pollIntervalMs,
          batchSize,
          destinations: Object.keys(dispatchers),
        },
        "Outbox reaper started"
      );
      void loop();
    },
    stop: async () => {
      if (!running) return;
      stopRequested = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) await inFlight;
      running = false;
      logger.info({ workerId }, "Outbox reaper stopped");
    },
  };
};
