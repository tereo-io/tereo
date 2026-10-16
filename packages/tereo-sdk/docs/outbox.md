# Outbox — @tereo-io/sdk

`core.outbox` writes audit entries, webhook events and notifications in the app's own database,
inside the caller's transaction: the entry, event or send exists exactly when the change commits,
and not at all when it rolls back. A reaper then sends committed rows to core. Code: `src/clients/outbox.ts` (`OutboxClient`),
`src/types/outbox.ts`, table SQL in `src/utils/outboxSchema.ts`. Core's own outbox, and how the two
compare, is in the [outbox skill](../../../.claude/skills/outbox/SKILL.md).

```ts
const core = createCoreClient({ service: "product-service", redis, outbox: { db: prisma } });
await core.start();       // starts the reaper
// the service's provisioning document lists its event types and asks for the roles
// webhook_publisher, audit_writer and notification_sender (see provisioning.md)

await prisma.$transaction(async (tx) => {
  const item = await tx.item.create({ data });
  await core.outbox.audit(tx, { userId, action: "CREATE", entityType: "Item", entityId: item.id });
  await core.outbox.emit(tx, {
    organizationId,
    eventType: "product.item.created",
    entityType: "Item",
    entityId: item.id,
    data: item,
  });
  await core.outbox.notify(tx, {
    channel: "email",
    organizationId,
    recipients: [{ address: "ops@example.com" }],
    content: { subject: `Item ${item.id} created`, text: "..." },
  });
});
```

The service needs the `audit_writer`, `webhook_publisher` and (for `notify`) `notification_sender`
roles, approved by an admin, for the reaper's sends to succeed.

## Writers

| Method | Takes | |
|--------|-------|---|
| `audit(tx, entry)` | `AuditLogEntryInput` — see [audit](audit.md#entries) | Row with `destination = "audit"` |
| `emit(tx, event)` | `EmitEventParams` — see [webhooks](webhooks.md#emitting) | Row with `destination = "webhook"`. Calls `webhooks.assertEventType` first, so an undeclared event type throws now, not at dispatch |
| `notify(tx, input)` | `NotificationInput` — the body of core's `POST /v1/notifications` ([core's notifications.md](../../tereo/docs/notifications.md#sending)) | Row with `destination = "notification"`. Throws now for an unknown channel, a recipient count outside 1 to 50, or an email with no `to` recipient (one without `as` counts as `to`); core checks the rest at dispatch |

Leave `idempotencyKey` out: the reaper sets it to the row id. Nothing is filled from a request
context — pass `ipAddress` and `correlationId` yourself. Each row also captures the active W3C trace
context; the reaper dispatches under it.

## Options

`OutboxOptions`, passed as `createCoreClient({ outbox })`:

| Option | Default | |
|--------|---------|---|
| `db` | — (required) | Anything with `$executeRawUnsafe` / `$queryRawUnsafe` (a Prisma client, or a thin `pg` wrapper). Used by the reaper outside any transaction. Postgres only |
| `table` | `core_outbox` | Optionally schema-qualified (`billing.core_outbox`). Lowercase letters, digits and `_` — it is interpolated into SQL |
| `dispatch` | `true` | Run the reaper in this process. `false` on write-only replicas |
| `pollIntervalMs` | 1000 | |
| `batchSize` | 100 | A full batch schedules the next pass at once |
| `maxAttempts` | 100 | ≈ 12 hours of retries |
| `retryBaseMs` | 2000 | |
| `maxBackoffMs` | 30 min | |
| `claimTtlMs` | 5 min | A claim older than this may be taken by another worker. Renewed per row just before it is sent, so it bounds one row's dispatch, retries included |

## The table

It belongs to the app and is created by the app's own migration. The reaper's SQL is hard-coded to
these columns — do not rename them. With Prisma, add this model so migrations create it and never
drop it:

```prisma
model CoreOutbox {
  id             String    @id @db.Uuid
  destination    String    @db.VarChar(64)
  payload        Json
  traceparent    String?   @db.VarChar(64)
  tracestate     String?   @db.VarChar(512)
  createdAt      DateTime  @default(now()) @map("created_at")
  nextAttemptAt  DateTime  @default(now()) @map("next_attempt_at")
  claimedAt      DateTime? @map("claimed_at")
  claimedBy      String?   @map("claimed_by") @db.VarChar(255)
  attempts       Int       @default(0)
  lastError      String?   @map("last_error") @db.VarChar(1000)
  deadLetteredAt DateTime? @map("dead_lettered_at")

  @@index([nextAttemptAt])
  @@map("core_outbox")
}
```

Without Prisma, `outboxTableSql(table)` returns the `CREATE TABLE` plus a partial index on pending
rows (`WHERE "dead_lettered_at" IS NULL`) for a SQL migration.

## The reaper

Started by `core.start()`, stopped by `core.stop()`. Any number of replicas can run one.

1. Claims due rows — oldest `next_attempt_at` first, not dead-lettered, unclaimed or with a stale
   claim — with `FOR UPDATE SKIP LOCKED`.
3. Sends them one at a time: `audit` rows via `audit.logAsync`, `webhook` rows via
   `webhooks.emitAsync`, `notification` rows via `notifications.sendAsync`, each with
   `idempotencyKey: row.id`. Each row's claim is renewed just before
   it is sent; a row whose claim lapsed and another worker took is skipped. Success deletes the row.
   The delete and the updates below apply only while `claimed_by` is still this worker.
4. On failure:
   - **Rejected by core** — any 4xx except 401, 403, 408, 409 (the same key still in flight) and 429 —
     the row is dead-lettered at once. Core answers 400 for an audit entry whose `userId` or
     `organizationId` it does not know, for an unregistered or retired event type or an unknown
     `recipients` slug, and for a
     notification it refuses (an unknown connection, an invalid recipient, an attachment it can't
     find).
   - **Refused by the SDK** before sending — an audit entry it finds invalid
     (`InvalidAuditEntryError`), an event type the service no longer declares
     (`UnknownEventTypeError`) — the row is dead-lettered at once.
   - **Anything else** (network, 5xx, 401, 403, 408, 409, 429) backs off with full jitter — a random delay
     up to `retryBaseMs × 2^attempts`, capped at `maxBackoffMs` — until `maxAttempts`, then it is
     dead-lettered. A 403 is retried because the access the row needs (`audit_writer`,
     `webhook_publisher`, `notification_sender`) may still await an admin's approval: rows written before then go out once
     it is approved.
   - A row whose `destination` has no dispatcher is dead-lettered.

A dead-lettered row is kept, with `dead_lettered_at` and `last_error` set, and logged as
`outbox.dead_letter` at error level. **Replay**: clear `dead_lettered_at`, set `attempts = 0` and
`next_attempt_at = NOW()`.

Delivery is at-least-once, deduplicated by core on the idempotency key for 24 hours. Order is not
guaranteed — a retried row goes after later ones, and replicas run independently — so subscribers
should tolerate reordering.

`processBatch()` runs one pass and returns how many rows it handled — tests call it to drain the
outbox deterministically.

## Best-effort sends

`core.audit.log` / `logBatch` and `core.webhooks.emit` / `emitBatch` send directly and swallow
failures; the `…Async` variants throw. None of them go through the outbox — don't use them for
writes that must not be lost.
