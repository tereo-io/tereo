import type { OutboxOptions, OutboxRow, SqlClient } from "../types/outbox.js";
import type { NotificationInput } from "../types/notifications.js";
import type { NotificationsClient } from "./notifications.js";
import type { AuditLogEntryInput } from "../types/audit.js";
import type { EmitEventParams } from "../types/webhooks.js";
import type { WebhookServiceClient } from "./webhooks.js";
import type { AuditLogServiceClient } from "./audit.js";
import { getOriginalStatus } from "../utils/errors.js";
import { UnknownEventTypeError } from "./webhooks.js";
import { quoteTable } from "../utils/outboxSchema.js";
import { logger } from "../utils/logger.js";
import { randomUUID } from "crypto";
import { v7 as uuidv7 } from "uuid";
import {
  InvalidAuditEntryError,
  validateEntry,
} from "../utils/auditSchemas.js";
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";

const tracer = trace.getTracer("@tereo-io/sdk/outbox");

type Dispatch = (payload: unknown, row: OutboxRow) => Promise<void>;

/**
 * Core refused the row itself (unknown user, undeclared event type, …), or the
 * SDK did before sending it, so a retry can't succeed. 409 is not: core answers it while the first request
 * with the same idempotency key is still in flight. Nor is 403: the service's
 * requested access (`audit_writer`, `webhook_publisher`) is refused until an
 * admin approves it.
 */
const isRejected = (err: unknown): boolean => {
  if (err instanceof InvalidAuditEntryError) return true;
  if (err instanceof UnknownEventTypeError) return true;
  const status = getOriginalStatus(err);
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    ![401, 403, 408, 409, 429].includes(status)
  );
};

const CHANNELS = ["email"];
const MAX_RECIPIENTS = 50;

const assertNotification = (input: NotificationInput): void => {
  if (!CHANNELS.includes(input.channel)) {
    throw new Error(
      `Unknown notification channel "${String(input.channel)}". Known channels: ${CHANNELS.join(", ")}`
    );
  }
  const count = Array.isArray(input.recipients) ? input.recipients.length : 0;
  if (count < 1 || count > MAX_RECIPIENTS) {
    throw new Error(
      `A notification takes 1 to ${MAX_RECIPIENTS} recipients, got ${count}`
    );
  }
  if (
    input.channel === "email" &&
    !input.recipients.some((r) => (r.as ?? "to") === "to")
  ) {
    throw new Error("An email needs at least one `to` recipient");
  }
};

export interface OutboxClientDeps {
  audit: AuditLogServiceClient;
  webhooks: WebhookServiceClient;
  notifications: NotificationsClient;
}

/**
 * The app service's transactional outbox. `audit` and `emit` write a row in
 * the caller's own transaction, so the entry or event exists exactly when the
 * business write commits. The reaper — any number of replicas may run one —
 * claims rows with `FOR UPDATE SKIP LOCKED`, sends them to core with the row id
 * as the idempotency key, and deletes them. Failures back off with full
 * jitter; after `maxAttempts`, or at once when core rejects the row with a
 * 4xx, a row is dead-lettered and kept. Replay: clear
 * `dead_lettered_at`, set `attempts = 0` and `next_attempt_at = NOW()`.
 */
export class OutboxClient {
  private readonly table: string;
  private readonly db: SqlClient;
  private readonly dispatchers: Record<string, Dispatch>;
  private readonly workerId = randomUUID();
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly claimTtlMs: number;
  private readonly runsReaper: boolean;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopRequested = false;

  constructor(
    options: OutboxOptions,
    private readonly deps: OutboxClientDeps
  ) {
    this.table = quoteTable(options.table ?? "core_outbox");
    this.db = options.db;
    this.runsReaper = options.dispatch ?? true;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.batchSize = options.batchSize ?? 100;
    // 100 attempts × 30 min cap × full jitter ≈ 12 hours of retry runway.
    this.maxAttempts = options.maxAttempts ?? 100;
    this.retryBaseMs = options.retryBaseMs ?? 2000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30 * 60 * 1000;
    // Each row's claim is renewed just before it is sent, so this bounds one
    // row's dispatch — retries and back-off included — not the batch's.
    this.claimTtlMs = options.claimTtlMs ?? 5 * 60_000;
    this.dispatchers = {
      audit: async (payload, row) => {
        await deps.audit.logAsync({
          ...(payload as AuditLogEntryInput),
          idempotencyKey: row.id,
        });
      },
      webhook: async (payload, row) => {
        await deps.webhooks.emitAsync({
          ...(payload as EmitEventParams),
          idempotencyKey: row.id,
        });
      },
      notification: async (payload, row) => {
        await deps.notifications.sendAsync({
          ...(payload as NotificationInput),
          idempotencyKey: row.id,
        });
      },
    };
  }

  // ===========================================================================
  // Writers — call inside the transaction that makes the change
  // ===========================================================================

  /** An audit entry, sent to core after `tx` commits. Rejects an invalid entry now. */
  async audit(tx: SqlClient, entry: AuditLogEntryInput): Promise<void> {
    validateEntry(entry);
    await this.insert(tx, "audit", entry);
  }

  /** A webhook event, sent to core after `tx` commits. Rejects an undeclared event type now. */
  async emit(tx: SqlClient, event: EmitEventParams): Promise<void> {
    this.deps.webhooks.assertEventType(event.eventType);
    await this.insert(tx, "webhook", event);
  }

  /**
   * A notification, sent to core after `tx` commits. Rejects an unknown
   * channel or a recipient count core would refuse now.
   */
  async notify(tx: SqlClient, input: NotificationInput): Promise<void> {
    assertNotification(input);
    await this.insert(tx, "notification", input);
  }

  private async insert(
    tx: SqlClient,
    destination: string,
    payload: unknown
  ): Promise<void> {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    await tx.$executeRawUnsafe(
      `INSERT INTO ${this.table} ("id", "destination", "payload", "traceparent", "tracestate")
       VALUES ($1::uuid, $2, $3::jsonb, $4, $5)`,
      uuidv7(),
      destination,
      JSON.stringify(payload),
      carrier.traceparent ?? null,
      carrier.tracestate ?? null
    );
  }

  // ===========================================================================
  // Reaper
  // ===========================================================================

  start(): void {
    if (!this.runsReaper || this.timer || this.inFlight) return;
    this.stopRequested = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  /** One pass: claim a batch and dispatch it. Returns how many rows it handled. */
  async processBatch(): Promise<number> {
    const rows = await this.claim();
    for (const row of rows) {
      if (this.stopRequested) break;
      await this.processRow(row);
    }
    return rows.length;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.processBatch()
        .catch((err) => {
          logger.error({ err }, "Outbox reaper pass failed");
          return 0;
        })
        .then((handled) => {
          this.inFlight = null;
          // A full batch means more may be waiting: go again at once.
          if (!this.stopRequested) {
            this.schedule(handled >= this.batchSize ? 0 : this.pollIntervalMs);
          }
        });
    }, delayMs);
    this.timer.unref?.();
  }

  private claim(): Promise<OutboxRow[]> {
    const stale = new Date(Date.now() - this.claimTtlMs);
    return this.db.$queryRawUnsafe<OutboxRow[]>(
      `UPDATE ${this.table} o
       SET "claimed_at" = NOW(), "claimed_by" = $1
       WHERE o."id" IN (
         SELECT "id" FROM ${this.table}
         WHERE "next_attempt_at" <= NOW()
           AND "dead_lettered_at" IS NULL
           AND ("claimed_at" IS NULL OR "claimed_at" < $2)
         ORDER BY "next_attempt_at" ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING o.*`,
      this.workerId,
      stale,
      this.batchSize
    );
  }

  /**
   * Renews this worker's claim on `row` just before it is sent. False when
   * the claim lapsed while earlier rows of the batch were sent and another
   * worker took the row: it is that worker's now.
   */
  private async renewClaim(row: OutboxRow): Promise<boolean> {
    const renewed = await this.db.$executeRawUnsafe(
      `UPDATE ${this.table}
       SET "claimed_at" = NOW()
       WHERE "id" = $1::uuid AND "claimed_by" = $2 AND "dead_lettered_at" IS NULL`,
      row.id,
      this.workerId
    );
    return renewed > 0;
  }

  private async processRow(row: OutboxRow): Promise<void> {
    if (!(await this.renewClaim(row))) {
      logger.debug(
        { outboxId: row.id },
        "Outbox row was claimed by another worker; skipping"
      );
      return;
    }
    const attempts = row.attempts + 1;
    const dispatch = this.dispatchers[row.destination];
    if (!dispatch) {
      await this.deadLetter(
        row,
        attempts,
        `No dispatcher for "${row.destination}"`
      );
      return;
    }

    const carrier: Record<string, string> = {};
    if (row.traceparent) carrier.traceparent = row.traceparent;
    if (row.tracestate) carrier.tracestate = row.tracestate;
    const parent = propagation.extract(context.active(), carrier);

    await context.with(parent, () =>
      tracer.startActiveSpan(
        `outbox.dispatch ${row.destination}`,
        {
          kind: SpanKind.PRODUCER,
          attributes: {
            "outbox.id": row.id,
            "outbox.destination": row.destination,
            "outbox.attempts": attempts,
          },
        },
        async (span) => {
          try {
            await dispatch(row.payload, row);
            // A worker that took the row meanwhile sends it again under the
            // same idempotency key, which core dedupes, and deletes it.
            await this.db.$executeRawUnsafe(
              `DELETE FROM ${this.table} WHERE "id" = $1::uuid AND "claimed_by" = $2`,
              row.id,
              this.workerId
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message });
            if (attempts >= this.maxAttempts || isRejected(err)) {
              await this.deadLetter(row, attempts, message);
            } else {
              await this.retryLater(row, attempts, message);
            }
          } finally {
            span.end();
          }
        }
      )
    );
  }

  private async retryLater(
    row: OutboxRow,
    attempts: number,
    error: string
  ): Promise<void> {
    const ceiling = Math.min(
      this.retryBaseMs * 2 ** attempts,
      this.maxBackoffMs
    );
    const nextAttemptAt = new Date(
      Date.now() + Math.floor(Math.random() * ceiling)
    );
    logger.warn(
      {
        outboxId: row.id,
        destination: row.destination,
        attempts,
        reason: error,
      },
      "Outbox row failed; will retry"
    );
    await this.db.$executeRawUnsafe(
      `UPDATE ${this.table}
       SET "attempts" = $2, "last_error" = $3, "next_attempt_at" = $4, "claimed_at" = NULL
       WHERE "id" = $1::uuid AND "claimed_by" = $5`,
      row.id,
      attempts,
      error.slice(0, 1000),
      nextAttemptAt,
      this.workerId
    );
  }

  private async deadLetter(
    row: OutboxRow,
    attempts: number,
    error: string
  ): Promise<void> {
    logger.error(
      {
        event: "outbox.dead_letter",
        outboxId: row.id,
        destination: row.destination,
        attempts,
        lastError: error,
      },
      "outbox.dead_letter"
    );
    await this.db.$executeRawUnsafe(
      `UPDATE ${this.table}
       SET "attempts" = $2, "last_error" = $3, "dead_lettered_at" = NOW(), "claimed_at" = NULL
       WHERE "id" = $1::uuid AND "claimed_by" = $4`,
      row.id,
      attempts,
      error.slice(0, 1000),
      this.workerId
    );
  }
}
