# Webhooks area

Webhook delivery in tereo, mounted at `/v1/webhooks` (`http://localhost:4001/v1/webhooks`
locally): the event type registry, per-organization endpoints, HMAC-SHA256 signing, async fan-out
via BullMQ, exponential backoff retry (10 attempts), and a daily-partitioned delivery table with
90-day retention. Every route needs a bearer token and is rate limited.

## Permissions

| Permission | Covers |
|------------|--------|
| `webhooks.read/write/archive/delete/admin` | Endpoint CRUD, archive/restore, hard delete, delivery viewing and retry, test sends, secret rotation |
| `webhooks.event-types.read` | Reading event types. They are declared by their services ([registry.md](registry.md)); there is no write API |
| `webhooks.emit` | Event emission. Core's `webhook_publisher` role grants it; a service may emit only the event types it declares, and none that are retired. Any other caller also needs `webhooks.admin`, and core's own event types (`auth.*`, `file-service.*`, `core.service.*`) are never emitted over HTTP — core emits them in-process |

`archivedAt` is an additive lifecycle marker, **independent of `status`** (ACTIVE/PAUSED/DISABLED
all stay operational). Archive (`POST /v1/webhooks/webhooks/:id/archive`, `webhooks.archive`) retires an
endpoint from any status; archived endpoints never receive deliveries and are hidden from the default
list (`filter[archived]=true` shows only them, `?includeArchived=true` shows both). Restore (`POST /v1/webhooks/webhooks/:id/restore`) clears
`archivedAt`, leaving `status` untouched. Archived endpoints are read-only (PATCH, rotate-secret,
revoke-previous-secret, test and delivery retries 409) until restored.

## Endpoints

Paths are under `/v1/webhooks`.

| Resource | Path | Methods | Permission |
|----------|------|---------|------------|
| Event types | `/v1/webhooks/event-types` | GET | `webhooks.event-types.read` |
| Event type | `/v1/webhooks/event-types/:eventType` | GET | `webhooks.event-types.read` |
| Endpoints | `/v1/webhooks/webhooks` | GET, POST | `webhooks.read` / `webhooks.write` |
| Endpoint | `/v1/webhooks/webhooks/:id` | GET, PATCH, DELETE (hard) | `webhooks.read` / `webhooks.write` / `webhooks.delete` |
| Archive / restore | `/v1/webhooks/webhooks/:id/archive` · `/restore` | POST | `webhooks.archive` |
| Rotate secret | `/v1/webhooks/webhooks/:id/rotate-secret` | POST | `webhooks.admin` |
| End rotation overlap | `/v1/webhooks/webhooks/:id/revoke-previous-secret` | POST | `webhooks.admin` |
| Test send | `/v1/webhooks/webhooks/:id/test` | POST | `webhooks.write` |
| Stats | `/v1/webhooks/webhooks/:id/stats` | GET | `webhooks.read` |
| Deliveries | `/v1/webhooks/webhooks/:id/deliveries` | GET | `webhooks.read` |
| Bulk retry | `/v1/webhooks/webhooks/:id/deliveries/retry` | POST | `webhooks.write` |
| Delivery | `/v1/webhooks/webhooks/:id/deliveries/:deliveryId` | GET | `webhooks.read` |
| Retry one | `/v1/webhooks/webhooks/:id/deliveries/:deliveryId/retry` | POST | `webhooks.write` |
| Emit | `/v1/webhooks/events` | POST | `webhooks.emit` |
| Emit batch | `/v1/webhooks/events/batch` | POST (max 100 events) | `webhooks.emit` |

- **Test send** — only for an `ACTIVE` endpoint. Creates a `webhook.test` delivery to that endpoint
  alone and returns `202 { deliveryId }`. This is the only way `webhook.test` is sent: it is
  reserved (`RESERVED_EVENT_TYPES` in `definitions/eventTypes.ts`), so emitting it, or subscribing an
  endpoint to it on create or update, is `400 reserved_event_type`. It stays registered because a
  delivery's event type is a foreign key into the registry. An endpoint subscribed to it before
  the ban never gets a delivery from it, since nothing can emit it; no cleanup is needed, but its
  next PATCH that resends `eventTypes` must drop it.
- **Stats** — delivery counts (`total`, `success`, `failed`, `pending`), the same for the last 24
  hours, `successRate` over completed deliveries and `averageAttempts`, all over the deliveries
  created in the last 30 days (`windowDays`, `STATS_WINDOW_DAYS`) so the query reads a bounded
  range of partitions.
- **Retry one** — only a `FAILED` delivery (otherwise `400 invalid_delivery_status`) of an
  `ACTIVE` endpoint (otherwise `400 invalid_endpoint_status`); it is reset to `PENDING` with zero
  attempts, no `lastAttemptAt`, response or error, and re-enqueued. The reset is conditional on
  `FAILED`, so of two concurrent retries one gets the 400. Returns `202` with the delivery.
- **Bulk retry** — the same for up to `limit` (default 100, max 1000) of the endpoint's `FAILED`
  deliveries, newest first, optionally narrowed by `createdAfter`, `createdBefore` and `eventType`.
  Rows a concurrent retry holds are skipped (`FOR UPDATE SKIP LOCKED`). Returns
  `202 { retriedCount }`.
- Both write an audit entry (`WebhookDelivery` / `retry`, or `WebhookEndpoint` /
  `retry-deliveries` when anything was reset).
- Test send, retry one and bulk retry queue their deliveries after the transaction commits. If
  Redis refuses the job, the failure is logged and the request still returns `202`: a 500 would
  have the client retry and write a second delivery. The stale-delivery sweep queues the delivery
  later.

**Multi-tenancy**: `resolveWebhookOrganizationId` sets `req.organizationId` from the token's
`org_id` for every `/v1/webhooks` route. A caller with `webhooks.admin` may name another
organization in `X-Organization-ID` (an unknown id is a 404, a malformed one a 400); anyone else's
header is ignored. The admin UI's organization switcher sends it on webhooks requests only.
`POST /v1/webhooks/events` takes `organizationId` in the body instead (service-to-service), under the
same rule as audit writes (`assertEmitScope`, `src/middleware/organizationId.ts`): a token with an
`org_id` emits only into that organization; an app service's token without one, or a
`webhooks.admin` caller, into any; anyone else's token without one (a person's, an
integration's), into none. It is checked before
the organization is looked up.

**Recipients act as their creator.** An endpoint is sent an event only while the user who created
it is active and could read the event themselves, in the endpoint's organization (their global roles,
plus that organization's while they are a member of it and it is active): they need `webhooks.read`
and the event type's `readPermission`, and for a `file-service.*` event, read access to the bucket
named in its `data.bucketName` (`src/utils/webhookAccess.ts`). Core's event types take theirs by
prefix (`READ_PERMISSIONS` in `definitions/eventTypes.ts`): `auth.user.*` needs `users.read`,
`core.service.*` `services.read`, `file-service.object.*` `file-service.objects.read`, and so on; a
service's event types take the one their declaration gives, if any ([registry.md](registry.md)).
Platform-wide events are emitted under the default organization, so without this any member of it
allowed to manage webhooks would receive every user, client and service change. Create and PATCH
check the caller the same way, against every event type the endpoint will be subscribed to:
`403` if they could not read one. The bucket is checked per event, when it is sent. An endpoint
whose creator is deactivated or loses access is simply sent nothing; it is not paused.
Delivery views (`GET …/deliveries`, `GET …/deliveries/:deliveryId` and the retry responses) apply
the same check to the caller: a delivery whose event they could not read comes back with
`payload` and `responseBody` set to `null` and `payloadRedacted: true`. For the same reason the
audit entry written for an event no endpoint was sent records its type and entity but not its data.

## Service-owned endpoints

A service's [provisioning document](provisioning.md#webhooks) can declare endpoints that deliver core
events to the service. They are ordinary endpoints with an owner:

- `ownerService` (`{ id, slug, name, kind }`, `kind` being `service` or `integration`), `ownerServiceId`, `provisioningKey` (`<service slug>:<key>`,
  plus `:<organization id>` when the document lists organizations) and `provisioned: true` are on
  the response; `organizationId` is `null` for an endpoint of **all organizations**, which exists
  only with an owner and receives the events of every organization. A list of organizations in the
  document makes one endpoint per organization.
- The signing secret comes from the environment variable the document names. Changing its value
  rotates it, with `WEBHOOK_SECRET_OVERLAP_HOURS` of overlap.
- The delivery check (`src/utils/webhookAccess.ts`) does not ask for `webhooks.read`. It asks for
  the event's `readPermission` (and bucket access for `file-service.*` events) of the owning
  service's account. A service's account does not hold its own permissions, so a webhook on the
  service's own events needs a role in the document's `access.roles` granting it.
- Fan-out for an event of organization X selects the endpoints of X and the owned endpoints of all
  organizations.
- Delivery history of an all-organization endpoint is shown per event's organization: a delivery's
  payload and response are redacted unless the viewer can read the event in that organization.
- Document URLs are checked at load: `http` or `https`, no credentials, and not `localhost` or a
  private or reserved IP literal. In-cluster hostnames pass. A service that must be reached at a
  private address declares [`internalHost`](provisioning.md#internal-webhook-targets): its own
  provisioned endpoints may then name exactly that host, at load and at every delivery.
  Loopback, link-local, unspecified and multicast addresses stay refused even when named, and
  only the service's own provisioned endpoints get the exception: endpoints made through the API, or
  owned by another service or an integration, never do.
- Provisioned endpoints answer `409 managed_by_provisioning` to `PATCH` (except one carrying only
  `status`, to re-enable), `DELETE`, archive, restore, rotate-secret and revoke-previous-secret.
  Delivery views, retries and test sends work. An endpoint a document drops is archived at once.

## List Filters

`filter[field]=value` with `filter[field_op]=operator` (default `equals`); `contains` is
case-insensitive.

| List | Filters |
|------|---------|
| `GET /v1/webhooks/webhooks` | `status` (`equals`, `in`), `url` (`contains`), `description` (`contains`), `eventType` (`equals`, `contains` — endpoints subscribed to a matching event type), `archived` (`true` / `false`; takes precedence over the older `includeArchived`) |
| `GET /v1/webhooks/webhooks/:id/deliveries` | `status` (`equals`, `in`), `eventType` (`equals`), `createdAt_gte` / `createdAt_lte` (ISO 8601; the bulk retry's `createdAfter` / `createdBefore` window) |
| `GET /v1/webhooks/event-types` | `source` (`equals`), `eventType` (`contains`), `retired` (`true` / `false`; omitted lists both) |

Event types carry `serviceName`, the declaring service's name, beside `source` (its slug) and
`serviceId`. They have no `id`: the name (`eventType`) is the primary key and the key for lists.

## Signing Secret Lifecycle

- **Create**: a 64-char hex secret, returned in full only once
- **Read/List**: masked as `first8chars...`
- **Rotate**: `POST .../rotate-secret` generates a new secret and returns it in full. The replaced
  secret keeps signing for `WEBHOOK_SECRET_OVERLAP_HOURS` (24; `0` drops it at once): until
  `previousSecretExpiresAt`, every delivery carries a signature for each secret, so the receiver
  can switch secrets at any point in that window. Rotating again during an overlap keeps only the
  secret just replaced. The previous secret is never returned.
- **Revoke previous**: `POST .../revoke-previous-secret` ends the overlap now; only the current
  secret signs from then on. A no-op when there is no overlap. Both write an audit entry; neither
  emits an event.
- **At rest**: both secrets are sealed with the key-encryption key (`sealRowSecret`, the same
  envelope as `core.secrets`), under one name per endpoint, `webhook-endpoint:<id>`, so a rotation
  moves the current ciphertext to `previous_signing_secret` unchanged (`utils/webhookSecrets.ts`).
  The masked value comes from `signing_secret_hint`, the first 8 characters kept beside it. The
  delivery job opens them to sign. A secret under the previous KEK (or, outside production, a plaintext
  one or one under the dev KEK) still signs, and is written back sealed under the current KEK when opened; on start
  every process also seals the ones left (`sealWebhookSecrets`, paged, each write conditional on
  the row still holding what was read, so replicas starting together are safe). A KEK rotation is
  covered the same way: with `CORE_KEK_PREVIOUS` set, the start pass re-seals rows under the old KEK.
  A previous secret past its overlap signs nothing, so the start pass clears it (column and expiry
  set to `NULL`) instead of sealing it.

## Custom Headers

An endpoint's `customHeaders` (up to 10) are sent with every delivery, with their stored values.
Core's own headers (`Content-Type`, `X-Webhook-*`) and the hop-by-hop and framing ones
(`Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`, `Trailer`, `Upgrade`, `Content-Length`,
`Host`, `Expect`, any `Proxy-*`) cannot be set: they are a `400` on create and update.
The values are often credentials, so they never leave core: every endpoint response, and the
`changes` of an update's audit entry, show each value as `********` (`HEADER_VALUE_MASK`,
`src/utils/webhookHeaders.ts`) and keep only the names. Names are case-insensitive, as in HTTP: two
that differ only in case are a `400`. On `PATCH`, a header sent with the mask as its value keeps
its stored value (matched case-insensitively), so a client can send back what it read with only some values
changed (the admin UI does); the mask for a header with no stored value — a new or renamed one — is
`400 masked_header_value`.

Endpoint responses also carry `hasDeliveries`: true while delivery history references the endpoint,
which makes a hard DELETE 409 until retention purges it.

## Integration-owned endpoints

An integration (`core.services` with `kind = integration`) manages its own endpoints through the
same `/v1/webhooks/webhooks` routes, with its own client-credentials token:

- It needs no `webhooks.*` permission (`requireWebhookPermission`, `routes/v1/webhooks/webhooks/middleware.ts`),
  and every route acts only on endpoints it owns: the list shows only those, and any other id is a
  404 (`getVisibleEndpoint`, with the request's `WebhookScope` from `utils/webhookOwnership.ts`).
  Its token's organization and `X-Organization-ID` play no part.
- Create sets `ownerServiceId` to the integration and `createdBy` to its account. An org-bound
  integration's endpoint is in its organization; a platform integration's has `organizationId: null`
  and is sent every organization's events.
- Create and PATCH take the full SSRF check (no private host, unlike a service with an
  `internalHost`) and `assertMaySubscribe` with the integration's own permissions. Core generates
  the signing secret and returns it once; rotate-secret, revoke-previous-secret, test sends,
  deliveries, stats, archive, restore and delete all work on its own endpoints.
- Delivery is checked as for a service-owned endpoint: the event's `readPermission` (and bucket
  access) of the integration's account in the event's organization, without `webhooks.read`. A
  deactivated integration's account is inactive, so it is sent nothing new. Its delivery views
  redact by the same rule.
- Everyone but the owning integration sees its endpoints only with `webhooks.admin`: without it they
  are absent from lists and a direct id is a 404, because the endpoint is sent what the integration
  may read and whoever could redirect it could read that too. An admin may pause it (a PATCH
  carrying only `status`), archive, restore and delete it, and read its deliveries. Any other PATCH
  field, rotate-secret, revoke-previous-secret, test sends and single or bulk delivery retries are
  `409 managed_by_integration`.

## Addressed events

`POST /v1/webhooks/events` (and each event of a batch), `emitTx` and the SDK's `core.outbox.emit`
take an optional `recipients`: up to 50 slugs of services or integrations. An addressed event is
sent only to ACTIVE endpoints those recipients own, in the event's organization or of all
organizations, each still subject to its owner's read permission; no other subscriber gets it.
Slugs are de-duplicated and sorted before the event is stored and hashed. An
unknown slug is `400 unknown_recipient` on emit, and dead-letters an outbox row. The delivery's
payload carries `recipients`. Who may emit the event type is unchanged. An unaddressed event goes
to every subscriber, as before.

## Event Emission Flow

Core's own events are written with `emitTx(tx, …)` to `core.outbox` in the mutation's transaction;
the worker's reaper hands each row to `dispatchOutboxEvent` (`src/utils/processEvent.ts`), which
writes the deliveries and a `webhooks.outbox_fanouts` row for the outbox row id in one
transaction (`INSERT … ON CONFLICT DO NOTHING`). A row claimed again after a crash between that
commit and the row's delete finds its fan-out recorded and completes without writing anything,
and two workers dispatching the same row at once write its deliveries once; a delivery written
but never queued is queued by the stale-delivery sweep. Redis takes no part in it. The reaper
claims up to 100 rows a poll and dispatches ten at a time,
so a burst cannot take the database pool from API requests. A claim older than a minute, by the
database's clock, may be taken by another worker; the first worker's late result then leaves the
row alone. `POST /v1/webhooks/events` takes the same path directly:

validate the event type (registered, not retired) → find ACTIVE, unarchived endpoints of the
organization subscribed to it → create a `WebhookDelivery` per endpoint in one transaction → enqueue
a BullMQ job per delivery → `202 { deliveriesCreated: N }`. With no matching endpoint, an audit entry
records the undelivered event.

`POST /v1/webhooks/events/batch` is all-or-nothing (`emitBatchWithIdempotency`): the whole batch is
validated — schema, reserved types, organizations, the caller's own event types, registered and
not retired — and every idempotency key claimed before anything is written; then every event's
deliveries and no-match audit entries go in one transaction, and the jobs are enqueued after it
commits. Keys are scoped per caller + organization + event type + key, as for a single emit, so
one caller can never answer or block another's key.
A key's claim lasts 60 seconds while its request runs, so a process that dies mid-request frees it;
the result is kept 24 hours:

- a key whose earlier request finished returns its cached result and writes nothing; the rest of
  the batch is still processed;
- the key's claim and its result store a hash of the event without the key (`canonicalJson`, so
  key order does not count): the same key with a different event, finished or still processing,
  fails the whole batch with `422 idempotency_key_conflict`, as audit's keys do;
- once the transaction commits the request succeeds and its keys stay claimed: a failure to
  enqueue a job or cache a result is logged, not returned, since a retry would duplicate the
  deliveries;
- a key still being processed fails the whole batch with `409 idempotency_request_in_progress`, releasing
  the keys the batch had claimed;
- the same key twice in one batch is `400 duplicate_idempotency_key`.

### Dead letters

The reaper retries a failing outbox row with exponential backoff, capped at 30 minutes, for 100
attempts (about 12 hours); a row that can never succeed (a malformed payload, a retired event
type, a destination with no dispatcher) is dead-lettered at once. A dead letter stays in
`core.outbox` with `dead_lettered_at` set and an `outbox.dead_letter` log line, and the reaper
leaves it alone. Once the cause is fixed, replay it:

```bash
npm run cli -- outbox-replay --id <uuid> [--id <uuid>]...
npm run cli -- outbox-replay --destination webhook --since 2026-10-14T08:00:00Z
npm run cli -- outbox-replay --all --dry-run
```

`--id` (repeatable), `--destination` and `--since` (dead-lettered at or after) combine; with none
of them the command refuses unless `--all` is given. It clears `dead_lettered_at`, resets
`attempts` to 0 and makes the rows due now, by the database's clock, and prints how many rows it
reset — or, with `--dry-run`, how many it would. The reaper then dispatches them as new rows.
`last_error` is kept until the next attempt replaces it.

The daily **outbox-retention** job deletes rows dead-lettered more than
`OUTBOX_DEAD_LETTER_RETENTION_DAYS` (default 30) ago; replay them before then. A replayed webhook
row that had already been fanned out completes without writing its deliveries again.

Payload envelope (stored with the delivery, so retries resend it unchanged; `webhook.test` has no
`organizationId`):

```json
{ "id": "<payload-uuid>", "organizationId": "...", "eventType": "...", "entityType": "...", "entityId": "...", "occurredAt": "...", "data": { ... } }
```

Delivery headers (`src/jobs/webhookDelivery.ts`), set after the endpoint's custom headers so those
cannot override them:

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `X-Webhook-Id` | The **delivery** id (`WebhookDelivery.id`), stable across retries — not the body's `id` |
| `X-Webhook-Event` | The event type |
| `X-Webhook-Timestamp` | Unix time in **seconds** at signing; each attempt is re-signed with a fresh one |
| `X-Webhook-Signature` | `sha256=` + lowercase hex `HMAC-SHA256(signingSecret, "${timestamp}.${rawBody}")`. During a rotation overlap, two comma-separated values — current secret first: `sha256=<new>,sha256=<old>`. Receivers should accept the request if any value matches (the SDK's `createWebhookVerifier` does) |

**Receivers should deduplicate on `X-Webhook-Id`.** Delivery is at least once: a delivery is sent
again when the receiver's response was lost or slower than the 30-second timeout, when the worker
crashed before recording an attempt's outcome, or when an admin retries it (retry one, bulk
retry). Every attempt carries the same `X-Webhook-Id` with a fresh timestamp and signature, so a
receiver should record the ids it has processed — at least for the automatic retry span, about 43
hours over ten attempts, and ideally for the 90-day retention a manual retry can reach back over —
and answer `2xx` without processing a repeat. The SDK's `createWebhookVerifier` verifies but does
not deduplicate.

## Background Jobs

Run by the worker (`ROLE=worker` or `all`):

- **webhook-delivery** — loads delivery + endpoint, signs, POSTs (30s timeout covering the
  connection and reading the response). A delivery that is no longer `PENDING` (a duplicate job)
  is skipped. 2xx → `SUCCESS`; otherwise BullMQ retries with exponential backoff from 5 minutes,
  and the 10th failure marks the delivery `FAILED`. The 10 are counted on the delivery
  (`attempts`), not the job, so a job the stale sweep re-queues continues the count rather than
  starting a fresh budget; its backoff does start again at 5 minutes. Five consecutive `FAILED` deliveries set an
  ACTIVE endpoint to `DISABLED` (only if it is still ACTIVE; an audit entry records it); a
  success, or setting the endpoint back to `ACTIVE`, resets the count. Only the first 4096 bytes
  of the response body are read and kept (NUL characters dropped). A signing secret that cannot
  be opened (sealed under a KEK the process does not have, or corrupt) is logged and counted as a
  failed attempt with the error `Signing secret cannot be opened`; nothing is sent. Such a delivery
  still ends `FAILED` after the 10th attempt, but since the fault is core's, it does not count
  toward the endpoint's consecutive failures. Every write of an attempt is conditional on the
  delivery still being `PENDING` with the attempt count the job read
  (`webhookDeliveries.updateIfUnchanged`), so a stale or duplicate job can neither reopen nor
  overwrite a settled delivery, and only the job whose write applied resets or counts the
  endpoint's failures.

  **SSRF**: `utils/ssrfGuard.ts`. On create/update, a URL must be http(s), without credentials,
  and not `localhost` or a private/reserved IP literal (IPv6 included: loopback, ULA,
  link-local, multicast, local-use NAT64 `64:ff9b:1::/48`, the IETF protocol assignments
  `2001::/23` (Teredo, benchmarking), documentation `2001:db8::/32` and `3fff::/20`,
  IPv4-mapped/IPv4-translated/NAT64/6to4 forms of private IPv4). At every attempt the host
  is resolved, every address checked, and the connection pinned to those addresses, so DNS
  rebinding cannot redirect it; redirects are never followed.
  An attempt that gets no response records a category, not the cause — `Target resolves to a
  private or reserved address`, `Target host could not be resolved`, `Request timed out` or
  `Connection failed` — since the endpoint's managers read it; the detail (addresses, resolver
  errors) is logged as `Webhook delivery attempt failed`. A response records `HTTP <status>`.
  Each delivery has at most one live job: the job id is the delivery id, and enqueueing while a
  job waits, backs off or runs is a no-op (`enqueueWebhookDelivery`, `jobs/webhookQueues.ts`). A
  finished job kept for inspection is replaced, so a retried delivery runs again.
- **stale-delivery-sweep** (every minute, `jobs/staleDeliverySweep.ts`) — a delivery is queued
  after its transaction commits, so one written while Redis was down stays `PENDING` with no job.
  The sweep looks at `PENDING` deliveries of any age, in every partition through its `status`
  index, since a retry makes a delivery up to 90 days old `PENDING` again. One never attempted
  (`lastAttemptAt` null) is queued once untouched for `WEBHOOK_STALE_DELIVERY_SECONDS` (300). One
  that has been attempted had a job, which is waiting out its backoff, so it is skipped until its
  last attempt is 24 hours old — longer than the longest backoff (21h20m, before the 10th
  attempt) — and only then queued, which recovers a job Redis lost. Either way, one that still has
  a live job is left alone. A retry clears `lastAttemptAt` with the other attempt fields, so a
  retried delivery counts as never attempted.
- **outbox-retention** (every 24h, `jobs/outboxRetention.ts`) — deletes `core.outbox` rows
  dead-lettered more than `OUTBOX_DEAD_LETTER_RETENTION_DAYS` ago (see
  [Dead letters](#dead-letters)), then the `outbox_fanouts` rows older than that whose outbox row
  is gone. One whose outbox row remains is kept, so a replayed row still finds it.
- **delivery-retention** (every 24h) — creates partitions 7 days ahead and then drops those older
  than 90 days, each create and drop under a 5-second `lock_timeout`: one that fails or finds the
  table locked is logged and left for the next run. Every process, whatever its `ROLE`, also creates today's and tomorrow's partition on
  start (`ensureCurrentPartitions`, `src/utils/partitions.ts`), so deliveries created by the API
  — `POST /v1/webhooks/events`, the endpoint test — keep working while the worker is down.

## Database Schema

Tables live in the `webhooks` schema.

| Model | Purpose |
|-------|---------|
| `EventType` | Event type registry (PK: `eventType` string), owned by the declaring service |
| `WebhookEndpoint` | Per-organization endpoints with signing secrets + event subscriptions |
| `WebhookDelivery` | Delivery records; **range-partitioned by day** (`webhook_deliveries_YYYY_MM_DD`) |
| `WebhookOutboxFanout` | `outbox_fanouts`: the outbox events already fanned out (PK: `outbox_id`), written with their deliveries |

Partitioned by `created_at`, the table's primary key is `(id, created_at)`. A delivery's
`(webhook_endpoint_id, created_at)` index serves an endpoint's list, stats and bulk retry. Lookups
by id pass `createdAt` when the caller knows it (the job data carries it, and the retry routes read
it first), so Postgres reads one partition (`DeliveryRef`, `utils/db/webhookDeliveries.ts`); a
miss there falls back to the id alone.

`DELETE /v1/webhooks/webhooks/:id` is a **hard delete** (internal maintenance only) — 409s while delivery
history still references the endpoint (`ON DELETE RESTRICT`), deletable once retention purges those
rows. For routine retirement use `POST /v1/webhooks/webhooks/:id/archive` (sets `archivedAt`, reversible).
The auto-disable path still sets `status = DISABLED` — an operational state distinct from the
archive lifecycle.

## Pagination

All list endpoints (`GET /v1/webhooks/event-types`, `GET /v1/webhooks/webhooks`, `GET /v1/webhooks/webhooks/:id/deliveries`)
use cursor-based keyset pagination. Response shape: `{ data, hasMore, limit, nextCursor }`. Cursors
are HMAC-signed opaque strings (the shared `CURSOR_SIGNING_KEY_V{n}`, generated into `core.secrets`
when unset) bound to the list that minted them — its request path, so a cursor from one
endpoint's deliveries does not page another's — and to the requested `sort` + `sortDir`;
tampering, or replay on another list or sort, returns `400 invalid_cursor`. Cursors minted before
the list binding (version 1) are refused too: a client mid-way through a list starts it again. There is no `total` — `COUNT(*)` is not cheap on the partitioned
`webhook_deliveries` table.

## Environment Variables

Besides core's shared ones in `src/env.ts` (`DATABASE_URL`, `REDIS_URL`, the cursor keys), the
webhooks area has two: `WEBHOOK_SECRET_OVERLAP_HOURS` (default 24), how long a rotated-out signing
secret keeps signing deliveries, and `WEBHOOK_STALE_DELIVERY_SECONDS` (default 300), how long a
`PENDING` delivery that was never attempted may go untouched before the stale-delivery sweep
queues it again. The outbox that feeds it has `OUTBOX_DEAD_LETTER_RETENTION_DAYS` (default 30),
how long a dead letter is kept for replay.

## Commands

From `packages/tereo`:

```bash
npm run dev                # Core with hot reload, port 4001
npm run db:migrate         # Create a migration from schema.prisma (doesn't apply it)
npm run db:migrate:deploy  # Apply migrations
npm run db:seed            # Seed (creates ±7 days of partitions)
npm run openapi:build      # Lint and re-bundle the OpenAPI spec
npm run cli -- outbox-replay --id <uuid>   # Replay a dead-lettered outbox row
```
