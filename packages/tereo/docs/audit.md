# Audit area

The audit log of tereo, mounted at `/v1/audit` (`http://localhost:4001/v1/audit` locally):
entries in a daily-partitioned table with time-based retention, and query APIs for change history.
Every route needs a bearer token and is rate limited.

Core writes its own entries with `logAuditTx(tx, …)` (`src/utils/outbox.ts`), in the mutation's
transaction. App services write theirs through the `@tereo-io/sdk` outbox or the HTTP API
below ([SDK notes](../../tereo-sdk/docs/audit.md)).

## Permissions

| Permission         | Covers                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `audit-logs.read`  | Query entries                                                                                      |
| `audit-logs.write` | Create entries (service-to-service)                                                                |
| `audit-logs.admin` | All of the above, and reading or writing another organization's or system-wide entries (see below) |

`audit-logs.delete` is declared but no route uses it: entries are never removable through the API.

## Endpoints

Paths are under `/v1/audit`.

| Endpoint                                         | Method | Permission         | Description                      |
| ------------------------------------------------ | ------ | ------------------ | -------------------------------- |
| `/v1/audit/entries`                              | POST   | `audit-logs.write` | Create one entry                 |
| `/v1/audit/entries/batch`                        | POST   | `audit-logs.write` | Create up to 1000 entries        |
| `/v1/audit/entries`                              | GET    | `audit-logs.read`  | List with pagination and filters |
| `/v1/audit/entries/facets`                       | GET    | `audit-logs.read`  | Values for the filter dropdowns  |
| `/v1/audit/entries/:id`                          | GET    | `audit-logs.read`  | Get one entry                    |
| `/v1/audit/entries/entity/:entityType/:entityId` | GET    | `audit-logs.read`  | Entity change history            |

Reads return each entry with `user` and `writer` (`{ id, email, name }`, for `userId` and
`writerUserId`) and `organization` (`{ id, name }`, `null` for a system-wide entry), loaded from
`auth` alongside the page.

`userEmail` is lower-cased on write, from the write API (and so from an app service's outbox, which
delivers through it) and from core's own `logAuditTx`. Entries written before that keep the case
they were sent in; rather than rewrite the partitioned table, the `userEmail` filter ignores case
(an `ILIKE` on the escaped value, in Prisma's list and in the `filter[q]` search alike).

## Organization scope

Every read — list, get, entity history, facets — goes through `resolveAuditOrganizationId`
(`src/middleware/organizationId.ts`), which sets `req.auditOrganizationId`:

| Caller             | `filter[organizationId]`           | Reads                                           |
| ------------------ | ---------------------------------- | ----------------------------------------------- |
| any                | absent, token has `org_id`         | the token's organization                        |
| `audit-logs.admin` | `<organization id>`                | that organization                               |
| `audit-logs.admin` | `none`                             | system-wide entries (`organization_id IS NULL`) |
| `audit-logs.admin` | absent, no `org_id`                | every organization                              |
| app service        | absent                             | its own entries, every organization             |
| app service        | `<organization id>` or `none`      | its own entries in that organization / none     |
| anyone else        | their own organization's id        | the token's organization                        |
| anyone else        | another id, `none`, or no `org_id` | `403`                                           |

`audit-logs.admin` is checked hierarchically, so the root `admin` permission qualifies.

An *app service* is a client of a `kind = service` row (`callerService`, `src/utils/callerService.ts`)
whose token has no `org_id` and does not cover `audit-logs.admin`. Its reads also get
`req.auditSourceScope` — `source` its slug and `writerUserId` its service account — which every
read applies on top of the caller's filters: as an extra `AND` clause on the list (so
`filter[source]=<another>` is an empty page), in the entity history's base `where`, on
`getById` (another service's entry is a `404`) and on the facets. `audit-logs.read` is enough,
through the requestable core role `audit_reader`; `audit_writer` (`audit-logs.write`) covers it.
Entries with the service's slug but another writer are not its own and stay hidden. An
integration's token without an `org_id` is not an app service and keeps the `403`. A person's
session always carries an `org_id`, so the admin UI reaches system-wide entries — those
written with no organization — only through `filter[organizationId]=none`.

### Writes

Both write endpoints check each entry's `organizationId` with `assertAuditWriteScope`
(`src/middleware/organizationId.ts`), after validation and before the existence check, so a
refused caller can't probe which organizations exist:

| Caller                                  | May write `organizationId`              |
| --------------------------------------- | --------------------------------------- |
| `audit-logs.admin`                      | any organization, or none (system-wide) |
| token with `org_id`                     | that organization only                  |
| service account, token without `org_id` | any organization, or none               |
| person, token without `org_id`          | nothing                                 |

Anything else is `403 forbidden`. For an organization-bound writer, a missing or `null`
`organizationId` is refused too: a system-wide entry lies outside its organization, as it does
for reads. A batch is all-or-nothing — one entry outside the caller's scope refuses the whole
batch and nothing is written.

A token without an `org_id` is the normal case for an app service: `POST /v1/admin/services` creates
its client with no organization, it is granted `audit_writer` globally, and its SDK outbox writes
entries for every tenant of its app with one set of credentials. Its writes are attributable
regardless — `writerUserId` is always the service account. A person's session always carries an
`org_id`, so a person's token without one has no organization to write for and is refused, as for
reads.

### Source

`source` is self-reported, except for an app service: its client writes only entries whose
`source` is its slug, and any other is `403` (one refuses a whole batch). Its reads, scoped by
source and writer, so hold exactly what it wrote. Core's own entries have source `tereo`
(`CORE_SOURCE`); `tereo` and `core` are reserved slugs (`CORE_RESERVED_SLUGS`), refused at
provisioning and by the admin API, so no service can pass for core.

## Filters and search

The list takes `filter[field]` / `filter[field_op]` on `source`, `userId`, `writerUserId`,
`userEmail` (equals or contains, both ignoring case — see below), `action`, `entityType`, `entityId`, `entityName`, `ipAddress`,
`correlationId` and `createdAt` (`_gte` / `_lte`), plus `metadata[<key>_equals|contains]=<value>`
on top-level metadata keys. Entity history takes `source`, `userId`, `writerUserId`, `userEmail`,
`action` and `createdAt`. The full list is in the OpenAPI spec (`openapi/paths/audit/entries.yaml`). A range can be given as
`filter[createdAt_gte]` / `filter[createdAt_lte]` or as `filter[createdAt]` + `filter[createdAt_op]`
(repeated for both bounds), in any mix and order; the bounds combine
(`src/utils/parseQueryString.ts`). A `metadata[...]` param of another form, or repeated, is a
`400` rather than ignored.

Postgres can store neither a NUL character in text nor a `\u0000` escape in `jsonb`, so the
schemas (`src/routes/v1/audit/entries/schemas.ts`) refuse one — in a written entry's strings,
`changes` and `metadata` (keys too), and in filter values and path params — with a `400` instead
of letting the query fail with a `500`. `userId` filters must be uuids and `createdAt` bounds fall
in the years 1-9999 for the same reason.

`filter[q]` searches the list: a case-insensitive substring of `entityName` or of the `changes` /
`metadata` JSON as text (keys match too). Prisma cannot express that, so `searchPaginated`
(`src/utils/db/auditLogEntries.ts`) compiles the list's Prisma `where` — filters, organization
scope and cursor — to SQL, picks the page's ids there, and loads them through Prisma. Matching
reads every row the other filters leave inside the window, with no index, so a search is bounded
to **31 days** of partitions: it defaults to the 31 days before the `lte` bound (or now), and an
explicit longer range, in either form, gets `400 search_window_too_large` (beyond a 5-minute
tolerance for client clock skew). Common terms stop early at the
page `LIMIT`; a rare term scans the window. A trigram index would make rare terms cheap but adds
a GIN write to every insert on the audit hot path, so there is none.

`GET /v1/audit/entries/facets` returns `sources`, `entityTypes` and `metadataKeys` under the same
organization scope as the list, drawn from the entries in a date window so the scan stays on
recent partitions: the list's `filter[createdAt_gte]` / `filter[createdAt_lte]`, or by default the
90 days before the end (`createdAt_lte`, or now). `metadataKeys` are the top-level keys of the most
recent 5000 entries with metadata in that window (at most 200 keys), so the query costs the same
however large the log grows; a key, source or entity type used only in older entries can still be
filtered on by name.

## Database

`audit.audit_log_entries` is range-partitioned by `created_at` (daily partitions
`audit_log_entries_YYYY_MM_DD`). Partitions are managed by:

- the seed — creates partitions for today ±7 days
- every process, whatever its `ROLE`, on start and before its first audited write (registering
  core's declaration, provisioning) — creates today's and tomorrow's partition of every
  partitioned table — audit entries, webhook deliveries, notifications and their deliveries
  (`ensureCurrentPartitions`, `src/utils/partitions.ts`). Without it, a worker down for more than the 7 days it creates
  ahead would leave no partition for new entries, and every audited write in core would fail. A
  table it finds locked is tried up to three times; a partition still missing then, or any other
  failure, is logged (today's as an error) and does not stop the start.
- the worker on start — runs `processEntryRetention()` once (`src/jobs/entryRetention.ts`)
- the `entry-retention` BullMQ job, every 24h — creates partitions 7 days ahead and then drops
  those older than `AUDIT_RETENTION_DAYS` (default 90). Each drop is on its own: one that fails is
  logged and left for the next run, and never stops the partitions ahead being created

Creating or dropping a partition takes `ACCESS EXCLUSIVE` on `audit_log_entries`, so both run
under a 5-second `lock_timeout` (`PARTITION_DDL_LOCK_TIMEOUT_MS`; `runPartitionDdl`, `src/utils/db/partitionDdl.ts`): behind a long
read they give up with a warning rather than queue every audited insert behind themselves, and the
next run retries. A create that gives up skips the later days too; with partitions made 7 days
ahead, a skipped run costs nothing. A partition that already exists takes no lock.

All of them go through `ensureDailyPartitions` (`src/utils/partitions.ts`), which uses
`CREATE TABLE IF NOT EXISTS … PARTITION OF`. Two processes starting together can both pass the
`IF NOT EXISTS` check; the loser's duplicate error (`42P07`, or `23505` on `pg_type`) is treated
as success.

## Idempotency

Both write endpoints take an optional `idempotencyKey`, scoped by the authenticated user and the
endpoint (`src/utils/auditIdempotency.ts`): the same key on `POST /entries` and
`POST /entries/batch` names two separate writes. A SHA-256 of the validated body (canonical JSON,
`idempotencyKey` left out) is stored with the claim. A repeat with the same body replays the stored
`201`; a different body gets `422 idempotency_key_conflict`. The pending claim lives 60s, so a crash
doesn't leave the key stuck; the stored result lives 24h. A second request while the first is
pending gets `409 idempotency_request_in_progress` (or 422 if its body differs), the code uploads
and emits use too. A stored value that cannot be read is treated as a miss: it is logged and
dropped, and the request claims the key and writes. A failed write releases the key; once the write
has committed the request succeeds even if storing its result fails (logged), and the pending
claim then expires on its own.

## Pagination

Both list endpoints use cursor-based keyset pagination. Response shape:
`{ data, hasMore, limit, nextCursor }`. Cursors are HMAC-signed opaque strings (the shared
`CURSOR_SIGNING_KEY_V{n}`) bound to the list that minted them (its request path) and the
requested `sort` + `sortDir`; tampering, or replay on another list or sort, returns
`400 invalid_cursor`. There is no `total` — `COUNT(*)` is not cheap on a partitioned table.

## Environment Variables

The audit-specific ones; the rest of core's settings are in `src/env.ts` and `.env.example`.

| Variable                                                     | Default                       |                                              |
| ------------------------------------------------------------ | ----------------------------- | -------------------------------------------- |
| `AUDIT_RETENTION_DAYS`                                       | `90`                          | Partitions older than this are dropped       |
| `CURSOR_SIGNING_KEY_V1`                                      | generated into `core.secrets` | HMAC key for list cursors (base64, 32 bytes) |
| `CURSOR_SIGNING_KEY_V2`, `CURSOR_ACTIVE_SIGNING_KEY_VERSION` | —, `1`                        | Key rotation                                 |

## Commands

From `packages/tereo`:

```bash
npm run dev                # Core with hot reload, port 4001
npm run db:migrate         # Create a migration from schema.prisma (doesn't apply it)
npm run db:migrate:deploy  # Apply migrations
npm run db:seed            # Seed (creates ±7 days of partitions)
npm run openapi:build      # Lint and re-bundle the OpenAPI spec
```
