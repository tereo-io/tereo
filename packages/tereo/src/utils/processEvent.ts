import { RESERVED_EVENT_TYPES, SYSTEM_USER_ID } from "../definitions/index.js";
import { emitEventSchema } from "../routes/v1/webhooks/events/schemas.js";
import { enqueueCommittedDelivery } from "../jobs/webhookQueues.js";
import { isRedisReady, limiterUnavailable } from "./rateLimit.js";
import { logAuditTx, PermanentDispatchError } from "./outbox.js";
import type { DeliveryRef } from "./db/webhookDeliveries.js";
import { createRecipientCheck } from "./webhookAccess.js";
import { canonicalJson } from "./uploadIdempotency.js";
import type { Prisma } from "./db/prisma.js";
import { getRedisClient } from "./redis.js";
import { prisma } from "./db/prisma.js";
import { logger } from "./logger.js";
import { createHash } from "crypto";
import db from "./db/index.js";
import z from "zod";
import {
  AppError,
  BadRequestError,
  IdempotencyInProgressError,
  UnprocessableEntityError,
} from "./errors.js";

type EmitEventInput = z.infer<typeof emitEventSchema>;
type Tx = Prisma.TransactionClient;

export interface ProcessEventResult {
  eventType: string;
  entityId: string;
  deliveriesCreated: number;
}

/** 400 `reserved_event_type` if any of `eventTypes` is reserved. */
export function assertNoReservedEventTypes(eventTypes: string[]): void {
  const reserved = [...new Set(eventTypes)].filter((et) =>
    RESERVED_EVENT_TYPES.has(et)
  );
  if (reserved.length > 0) {
    throw new BadRequestError(
      "reserved_event_type",
      `Reserved event types cannot be emitted or subscribed to: ${reserved.join(", ")}. ` +
        "Use POST /v1/webhooks/webhooks/{id}/test to send a test delivery."
    );
  }
}

/**
 * Every event type must be emittable: not reserved, registered, not retired.
 * Returns each one's read permission.
 */
async function assertEmittable(
  eventTypes: string[]
): Promise<Map<string, string | null>> {
  assertNoReservedEventTypes(eventTypes);
  const distinct = [...new Set(eventTypes)];
  const rows = await prisma.eventType.findMany({
    where: { eventType: { in: distinct } },
    select: { eventType: true, retiredAt: true, readPermission: true },
  });
  const byName = new Map(rows.map((r) => [r.eventType, r]));
  for (const eventType of distinct) {
    const row = byName.get(eventType);
    if (!row) {
      throw new BadRequestError(
        "invalid_event_type",
        `Event type "${eventType}" is not registered. Declare it in the service's registration first.`
      );
    }
    if (row.retiredAt) {
      throw new BadRequestError(
        "event_type_retired",
        `Event type "${eventType}" is retired: its service no longer declares it.`
      );
    }
  }
  return new Map(rows.map((r) => [r.eventType, r.readPermission]));
}

type PlannedEvent = {
  event: EmitEventInput;
  endpointIds: string[];
};

async function planEvent(
  event: EmitEventInput,
  readPermission: string | null
): Promise<PlannedEvent> {
  const endpoints = await db.webhookEndpoints.findActiveByOrgAndEvent(
    event.organizationId,
    event.eventType
  );
  const mayReceive = createRecipientCheck(event, readPermission);
  const endpointIds: string[] = [];
  for (const endpoint of endpoints) {
    if (await mayReceive(endpoint.createdBy)) endpointIds.push(endpoint.id);
  }
  return { event, endpointIds };
}

/**
 * Write one event's deliveries, or the audit entry recording that nothing
 * matched, in the caller's transaction. Returns the deliveries to enqueue
 * once it commits.
 */
async function writeEventTx(
  tx: Tx,
  { event, endpointIds }: PlannedEvent,
  occurredAt: Date
): Promise<DeliveryRef[]> {
  if (endpointIds.length === 0) {
    await logAuditTx(tx, {
      auth: { userId: SYSTEM_USER_ID, email: null },
      organizationId: event.organizationId,
      action: "CREATE",
      entityType: "WebhookEvent",
      entityId: crypto.randomUUID(),
      metadata: {
        eventType: event.eventType,
        entityType: event.entityType,
        entityId: event.entityId,
        // Not the event's data: anyone reading the organization's audit log
        // would see what no recipient, and maybe not they, could read.
        deliveriesCreated: 0,
        reason: "no-matching-endpoints",
      },
    });
    return [];
  }

  const written: DeliveryRef[] = [];
  for (const webhookEndpointId of endpointIds) {
    const payload = {
      id: crypto.randomUUID(),
      organizationId: event.organizationId,
      eventType: event.eventType,
      entityType: event.entityType,
      entityId: event.entityId,
      occurredAt: occurredAt.toISOString(),
      data: event.data,
    };
    const delivery = await db.webhookDeliveries.create(
      { webhookEndpointId, eventType: event.eventType, payload },
      tx
    );
    written.push({ id: delivery.id, createdAt: delivery.createdAt });
  }
  return written;
}

const toResult = (
  event: EmitEventInput,
  deliveriesCreated: number
): ProcessEventResult => ({
  eventType: event.eventType,
  entityId: event.entityId,
  deliveriesCreated,
});

/**
 * Validate, plan and write every event in one transaction, then enqueue the
 * deliveries. BullMQ enqueue is post-commit: queue jobs aren't transactional.
 * With `outbox`, the transaction also records that outbox event as fanned
 * out, and writes nothing if an earlier one already did; its events occurred
 * when the row was written, however long it waited to be dispatched.
 */
async function processEvents(
  events: EmitEventInput[],
  outbox?: { id: string; createdAt: Date }
): Promise<ProcessEventResult[]> {
  const readPermissions = await assertEmittable(events.map((e) => e.eventType));
  const plans = await Promise.all(
    events.map((e) => planEvent(e, readPermissions.get(e.eventType) ?? null))
  );
  const occurredAt = outbox?.createdAt ?? new Date();

  const deliveries = await db.$transaction(async (tx) => {
    if (outbox && !(await db.outboxFanouts.claim(tx, outbox.id))) {
      return events.map((): DeliveryRef[] => []);
    }
    const perEvent: DeliveryRef[][] = [];
    for (const plan of plans) {
      perEvent.push(await writeEventTx(tx, plan, occurredAt));
    }
    return perEvent;
  });

  for (const delivery of deliveries.flat()) {
    await enqueueCommittedDelivery(delivery);
  }

  return events.map((event, i) => toResult(event, deliveries[i].length));
}

// Scope idempotency keys per (caller, organizationId, eventType) so the same
// caller-chosen string can't collide across callers, tenants or event
// categories — and one caller can't pre-empt another's key.
const IDEMPOTENCY_PREFIX = "webhook-service:idempotency:";
const IDEMPOTENCY_TTL_SECONDS = 86400; // 24 hours
const PROCESSING_MARKER = "__processing__";
// Long enough for any request to finish, short enough that a process dying
// mid-request doesn't hold the key — and 409 every retry — for a day.
const PROCESSING_TTL_SECONDS = 60;

function idempotencyCacheKey(
  callerUserId: string,
  organizationId: string,
  eventType: string,
  idempotencyKey: string
): string {
  return `${IDEMPOTENCY_PREFIX}${callerUserId}:${organizationId}:${eventType}:${idempotencyKey}`;
}

const cacheKeyOf = (
  event: EmitEventInput,
  callerUserId: string
): string | null =>
  event.idempotencyKey
    ? idempotencyCacheKey(
        callerUserId,
        event.organizationId,
        event.eventType,
        event.idempotencyKey
      )
    : null;

interface StoredEmit {
  bodyHash: string;
  result: ProcessEventResult;
}

/** The event as its key guards it: everything but the key itself. */
const bodyHashOf = ({ idempotencyKey: _key, ...event }: EmitEventInput) =>
  createHash("sha256").update(canonicalJson(event)).digest("hex");

/**
 * A key's stored value: the processing marker and the claiming event's hash,
 * or the event's hash and result. A value without a hash (a bare marker or
 * result, as stored before hashes were) matches any event.
 */
const parseStoredEmit = (
  value: string
): { processing: boolean; bodyHash?: string; result?: ProcessEventResult } => {
  if (value.startsWith(PROCESSING_MARKER)) {
    const bodyHash = value.slice(PROCESSING_MARKER.length + 1);
    return { processing: true, bodyHash: bodyHash || undefined };
  }
  const parsed = JSON.parse(value) as StoredEmit | ProcessEventResult;
  if ("bodyHash" in parsed && "result" in parsed) {
    return { processing: false, ...parsed };
  }
  return { processing: false, result: parsed };
};

const keyReusedError = () =>
  new UnprocessableEntityError(
    "idempotency_key_conflict",
    "This idempotency key was already used with a different event"
  );

const inProgressError = () =>
  new IdempotencyInProgressError(
    "A request with this idempotency key is still being processed; retry shortly."
  );

/**
 * The outbox reaper's `webhook` dispatcher. Fan-out is recorded in
 * `webhooks.outbox_fanouts` in the transaction that writes the deliveries, so
 * a row re-claimed after a crash between that commit and the row's delete
 * completes without writing them again; a delivery written but never queued
 * is queued by the stale-delivery sweep. A malformed payload or a 4xx (a
 * retired or unregistered event type) would fail the same way on every
 * retry, so it is permanent.
 */
export async function dispatchOutboxEvent(
  payload: unknown,
  rowId: string,
  rowCreatedAt: Date
): Promise<void> {
  const parsed = emitEventSchema.safeParse(payload);
  if (!parsed.success) {
    throw new PermanentDispatchError(
      `Malformed webhook outbox payload: ${parsed.error.message}`
    );
  }
  // Already fanned out: done, even if its event type has since been retired.
  if (await db.outboxFanouts.exists(rowId)) return;
  try {
    await processEvents([parsed.data], { id: rowId, createdAt: rowCreatedAt });
  } catch (err) {
    if (
      err instanceof AppError &&
      err.statusCode >= 400 &&
      err.statusCode < 500
    ) {
      throw new PermanentDispatchError(`${err.code}: ${err.message}`);
    }
    throw err;
  }
}

/** `callerUserId` scopes the idempotency key: the authenticated emitter. */
export async function emitWithIdempotency(
  body: EmitEventInput,
  callerUserId: string
): Promise<ProcessEventResult> {
  const [result] = await emitBatchWithIdempotency([body], callerUserId);
  return result;
}

/**
 * Emit a batch all-or-nothing. Every event is validated, and every
 * idempotency key claimed, before anything is written; all deliveries and
 * audit entries then go in one transaction.
 *
 * Keys are scoped per (caller, organizationId, eventType, idempotencyKey),
 * as for a single emit:
 * - a key whose earlier request finished returns that cached result and
 *   writes nothing, while the rest of the batch is processed;
 * - a key used before with a different event (anything but the key differs)
 *   fails the whole batch with `422 idempotency_key_conflict`;
 * - a key whose earlier request is still processing fails the whole batch
 *   with `409 idempotency_request_in_progress`, and the keys this batch claimed are
 *   released;
 * - the same key twice in one batch is a `400 duplicate_idempotency_key`.
 */
export async function emitBatchWithIdempotency(
  events: EmitEventInput[],
  callerUserId: string
): Promise<ProcessEventResult[]> {
  assertNoReservedEventTypes(events.map((e) => e.eventType));

  const cacheKeys = events.map((e) => cacheKeyOf(e, callerUserId));
  const seen = new Set<string>();
  for (const key of cacheKeys) {
    if (!key) continue;
    if (seen.has(key)) {
      throw new BadRequestError(
        "duplicate_idempotency_key",
        "Two events in the batch share an idempotency key, organization and event type."
      );
    }
    seen.add(key);
  }

  if (seen.size === 0) return processEvents(events);
  const bodyHashes = events.map(bodyHashOf);

  // Without Redis no key can be checked: refuse with a 503 rather than wait
  // for a reconnect or emit what may be a duplicate.
  const redis = getRedisClient();
  if (!isRedisReady(redis)) throw limiterUnavailable();
  const claimRedis = async <T>(command: () => Promise<T>): Promise<T> => {
    try {
      return await command();
    } catch (err) {
      logger.error(
        { err },
        "Redis unavailable while claiming an emit idempotency key"
      );
      throw limiterUnavailable();
    }
  };
  const claimed: string[] = [];
  const cached = new Map<number, ProcessEventResult>();
  const release = () =>
    claimed.length > 0
      ? redis.del(...claimed).catch(() => undefined)
      : Promise.resolve();

  let freshResults: ProcessEventResult[];
  try {
    // Atomic claim: only one caller wins each SET NX. A key already present
    // holds either a finished result or the processing marker.
    for (const [i, key] of cacheKeys.entries()) {
      if (!key) continue;
      const won = await claimRedis(() =>
        redis.set(
          key,
          `${PROCESSING_MARKER}:${bodyHashes[i]}`,
          "EX",
          PROCESSING_TTL_SECONDS,
          "NX"
        )
      );
      if (won === "OK") {
        claimed.push(key);
        continue;
      }
      const value = await claimRedis(() => redis.get(key));
      if (!value) throw inProgressError();
      const stored = parseStoredEmit(value);
      if (stored.bodyHash && stored.bodyHash !== bodyHashes[i]) {
        throw keyReusedError();
      }
      if (stored.processing || !stored.result) throw inProgressError();
      cached.set(i, stored.result);
    }

    const fresh = events.filter((_, i) => !cached.has(i));
    freshResults = fresh.length > 0 ? await processEvents(fresh) : [];
  } catch (err) {
    // Nothing was written: release the claims so the caller can retry
    // without waiting for them to expire.
    await release();
    throw err;
  }

  let next = 0;
  const results = events.map((_, i) => cached.get(i) ?? freshResults[next++]);

  // Written and committed: the claims stay even if caching a result fails, so
  // a retry gets 409 until they expire. The request itself succeeds, so only
  // a caller that never saw the response retries.
  for (const [i, key] of cacheKeys.entries()) {
    if (!key || cached.has(i)) continue;
    const stored: StoredEmit = { bodyHash: bodyHashes[i], result: results[i] };
    await redis
      .set(key, JSON.stringify(stored), "EX", IDEMPOTENCY_TTL_SECONDS)
      .catch((err) => {
        logger.error(
          { err },
          "Failed to cache an emitted event's idempotency result"
        );
      });
  }
  return results;
}
