# Audit — @tereo-io/sdk

`core.audit` is an `AuditLogServiceClient` (`src/clients/audit.ts`, types in `src/types/audit.ts`)
over core's `/v1/audit/entries`. Its `source` is the `service` passed to `createCoreClient`: every
entry it writes carries it, and every read is filtered to it.

**Entries that must not be lost go through the [outbox](outbox.md)** — `core.outbox.audit(tx, entry)`
in the transaction that makes the change. The write methods here send directly; the outbox reaper is
their main caller.

## Entries

`AuditLogEntryInput`:

| Field                        | Required |                                                                                                                                                                |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `userId`                     | yes      | The acting user, a UUID; core rejects one it does not know                                                                                                     |
| `action`                     | yes      | `CREATE`, `UPDATE`, `DELETE`, `MERGE`, `ARCHIVE` or `RESTORE`                                                                                                  |
| `entityType`                 | yes      | e.g. `"Item"`                                                                                                                                                  |
| `entityId`                   | yes      | At most 500 characters                                                                                                                                         |
| `organizationId`             | no       | Core rejects one it does not know                                                                                                                              |
| `userEmail`, `entityName`    | no       | An empty `userEmail` is sent as `null`                                                                                                                         |
| `changes`                    | no       | `{ field: { old, new } }` — see `computeChanges`                                                                                                               |
| `metadata`                   | no       | Free-form JSON                                                                                                                                                 |
| `ipAddress`, `correlationId` | no       | Not filled in for you. An empty `ipAddress` is sent as `null`                                                                                                  |
| `idempotencyKey`             | no       | Held by core for 24 hours per writer. Generated once per call when omitted, so the request handler's retries write one entry. The outbox sets it to the row id |

Entries are validated with Zod before any request is made, against the rules core applies; no
string, JSON key or JSON value may contain a NUL character. An invalid entry throws
`InvalidAuditEntryError` — from `core.outbox.audit()` before the row is written, and the reaper
dead-letters an older row that fails it rather than retrying.

`AuditLogServiceClient.computeChanges(old, next)` (static) returns the field-level diff for
`changes`, skipping `createdAt`, `updatedAt`, `deletedAt` and `archivedAt`, and `undefined` when
nothing else changed.

## Writes

| Method                   | Returns          |                                                                                                                                                                        |
| ------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `log(entry)`             | `void`           | Best-effort: calls `logAsync` and logs any failure                                                                                                                     |
| `logAsync(entry)`        | `AuditLogResult` | `POST /v1/audit/entries`; throws on failure                                                                                                                            |
| `logBatch(entries)`      | `void`           | Best-effort; invalid entries are skipped. Max 1000                                                                                                                     |
| `logBatchAsync(entries)` | `{ created }`    | `POST /v1/audit/entries/batch`; throws on failure or more than 1000. An entry's `idempotencyKey` is not sent: core keys the whole batch, with a key generated per call |

## Reads

Reads need the core role `audit_reader` (`audit-logs.read`) or `audit_writer` in the service's
`access.roles`. Core scopes them to the entries this service wrote — `source` its slug, written by
its own client — in every organization and system-wide; `filter.source` naming another source
gives an empty page, and `getById` of another service's entry is a 404. The SDK also sends
`filter[source]` as the client's `source` (the `service` option, which must be the service's slug:
core refuses an entry under any other source with `422 source_mismatch`, which the outbox
dead-letters at once). Paged
results are `{ data, hasMore, limit, nextCursor }`; pass `nextCursor` back as `cursor`. Each entry
carries `writerUserId` and names its `user`, `writer` and `organization` (`AuditLogReadResult`).

| Method                                                                                   |                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query(options?)`                                                                        | `AuditLogQueryOptions`: `limit`, `cursor`, `sort: "createdAt"`, `sortDir`, `filter` (per field: `equals`, `in`, `contains`, `gte`/`lte` on `createdAt`; `q` searches text over at most 31 days) and `metadata` (`{ key: { equals?, contains? } }`)                                 |
| `getByEntity(entityType, entityId, options?)`                                            | One entity's history. `options.organizationId` (an id or `"none"`) narrows it to one organization, or to system-wide entries                                                                                                                                                       |
| `getById(id)`                                                                            | One entry, by id — only one this service wrote                                                                                                                                                                                                                                     |
| `queryByEntityOrMetadata({ entityId, metadataKey, limit?, cursor?, sortDir?, filter? })` | A parent's history: entries whose `entityId` matches, merged with those whose `metadata[metadataKey]` does (e.g. order lines carrying `metadata.orderId`). Deduplicated, in core's order, one composite cursor. A page can hold fewer than `limit` entries while `hasMore` is true |

## Other

`AuditLogServiceClient.noop()` returns a client whose methods do nothing and return empty results —
see [testing](testing.md). `init()` / `close()` / `isReady()` only toggle a flag; `core.start()` and
`core.stop()` call them.
