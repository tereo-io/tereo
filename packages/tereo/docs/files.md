# Files area

S3-like object storage in tereo, mounted at `/v1/files` (`http://localhost:4001/v1/files`
locally). Paths below are relative to that mount — `/buckets` is `GET /v1/files/buckets` — except where
written out in full.

Core capabilities: bucket management, dual permission model, SHA-256 content-addressable deduplication, storage quotas, access logging, envelope encryption at rest, object versioning, ETag-conditional requests, multipart uploads, presigned URLs, shares, per-bucket CORS + rate limiting, webhook emission, lifecycle/retention policies, and thumbnail generation.

Mutations pair their audit entry and webhook event with the business write — `logAuditTx(tx, …)`
and `emitTx(tx, …)` from `src/utils/outbox.ts`, inside the mutation's `db.$transaction` (see the
`outbox` skill).

## Layout

The files area shares core's `src/` with the other areas:

```
src/
├── routes/v1/files/
│   ├── buckets/        # GET/POST /buckets
│   │   └── bucket/     # /buckets/:name + archives/, lifecycle/, multipart/, objects/, permissions/, shares/
│   │       └── objects/   # by-key/object/, object/ (reads and upload by key), by-id/object/ (mutations, versions)
│   ├── signed/         # /signed — presigned URL access (no auth)
│   └── shared/         # /shared — public share links (no auth)
├── middleware/         # accessLog.ts, bucketCors.ts, bucketRateLimit.ts
├── jobs/               # lifecycleSweep, multipartSweep, orphanBlobCleanup, idempotencySweep, shareSweep, archiveSweep, thumbnailGeneration, …
├── cli/                # rewrap-master-key
└── utils/
    ├── encryption.ts, masterKeys.ts  # Envelope encryption (AES-256-GCM + wrapped DEK)
    ├── presigning.ts   # HMAC-SHA256 stateless signed URLs
    ├── storage.ts      # Blob-layer storage (streaming save, sharded paths)
    ├── thumbnails.ts   # sharp-based image thumbnail pipeline (no SVG; inputs over 50 MP skipped)
    ├── uploadIdempotency.ts, archiveStream.ts, shareUnlockLimiter.ts, password.ts
    └── cacheBroadcast.ts  # Redis pub/sub for SDK cache invalidation
```

## Dual Permission Model

Operations require **both**:
1. **System permission** (in the token): `file-service.buckets.read/write/delete`, `file-service.objects.read/write/delete`, `file-service.permissions.read/write/delete`, `file-service.shares.read/write/delete`, `file-service.admin`. Names live in `src/definitions/permissions.ts` (`PERMISSIONS.*` for call sites), registered with the rest of core's declaration on every start.
2. **Bucket-level permission** (BucketPermission record): `canRead`, `canWrite`, `canDelete`

Creating a bucket also grants its creator full object access (`canRead`, `canWrite`, `canDelete`), in the same transaction, audited and emitted (`file-service.permission.granted`) like any grant. It is an ordinary grant: listed under `/permissions`, and revocable — after which the creator, as long as they are its owner, neither manages the bucket (below) nor has object access until a `file-service.admin` holder grants it back. Object operations check the grant (`validateBucketAccess`), with only `file-service.admin` bypassing it; there is no creator special case. Access to an organization's bucket is checked against the token's organization, so a grant on one goes only to a user who can act in it — a member, or the service-account user of a client bound to it (`canActInOrganization` in `utils/users.ts`); anyone else is `400 user_not_in_organization`; a `userId` that names no user is `400 unknown_user`. Removing a member from an organization revokes their grants on its buckets in the same transaction, each audited (`reason: "organization_member_removed"`) and emitted like any revoke; their shares stay unless the removal asks for `?revokeShares=true` (see [Shares](#shares)). Each grant and revoke also pushes `files:bucket-access:changed` (`{ bucketName, timestamp }`) to the user's sockets after commit; it asks for no token refresh, since grants are not in the token. `GET /buckets/:name/my-permissions` reports the caller's effective access as booleans: each grant flag AND the role permission the object routes require with it (`file-service.objects.read` / `.write` / `.delete`, already cut to a delegated token's ceiling, so a `core:files.read` token reports `canWrite: false`). `canRead` is also true on a public bucket; a `file-service.admin` holder gets all three. On a retired bucket `canWrite` is false for everyone, admins included. It refuses another organization's bucket, and a private bucket the caller holds no active grant on, with the same `403` as a missing bucket, so it can't confirm that a name exists. Public buckets allow unauthenticated read access — the object list and prefixes, download and HEAD by key, `by-key/`, and by id: `GET`/`HEAD /objects/by-id/:id`, its versions list, one version and a version's download. A caller served only because the bucket is public sees no writers' ids, emails or names in the versions list. Nor does a public bucket show its history to everyone it is served to: deleted objects (`?deleted=true` is `401` without a token, `403` with one), a deleted object's versions, and versions no longer current (left out of the versions list, `404` by id or as `?versionId=`) are for callers who could read the bucket were it private — a grant or `file-service.admin` (`seesBucketHistory` in `objects/utils.ts`, `holdsBucketReadAccess` in `utils/bucketAccess.ts`). A presigned URL takes no token: its HMAC is the credential, and it acts with its signer's access, re-checked on each use (see [Presigned URLs](#presigned-urls)).

**Access is checked before anything about the bucket is revealed.** A caller without access gets the same `403` for a bucket that doesn't exist as for one they can't access — only callers who could see it (`file-service.admin`) get `404 Bucket not found`. On the read routes admitted without a token, an anonymous caller is served from a public bucket and gets `401` for a private or missing one. Bucket settings (`versioning_disabled` on the versions routes, a retired bucket's `409 bucket_retired`) are only reported once the permission check has passed. `getAccessibleBucket` / `getReadableBucket` / `getManagedBucket` in `utils/bucketAccess.ts`.

**Managing a bucket** — updating it (policy, quota, CORS, rate limit, …), granting and revoking access, deleting it — takes the matching `file-service.buckets.*` / `file-service.permissions.*` permission and either holding `file-service.admin` (checked hierarchically, so the bare `admin` permission counts) or being its owner (`ownerId`) **with an active grant on it** (any flags). Once an admin revokes the owner's grant, the owner can't grant it back: only `file-service.admin` can. A grant gives no flag the granter's own active grant lacks (`403`), so an owner holding `canRead` and `canWrite` can't hand out `canDelete`; `file-service.admin`, which needs no grant, gives any (`assertWithinOwnGrant` in `utils/bucketGrants.ts`). Revoking a grant (`DELETE /buckets/:name/permissions/:userId`) leaves the user's shares serving; `?revokeShares=true` also revokes theirs on that bucket (see [Shares](#shares)). Reading the settings (`GET /buckets/:name`, `/permissions`, `/lifecycle`) takes any active grant, as does seeing the bucket in `GET /buckets`. `ownerId` starts as the creator; `createdBy` is the creator and never changes. `PUT /buckets/:name/owner { userId }` (`file-service.admin` only) transfers it: the new owner must be an active user who can act in the bucket's organization (`400 user_inactive` / `user_not_in_organization` / `unknown_user`), and gets a full grant (`canRead`, `canWrite`, `canDelete`) unless they already hold an active one, which is kept as it is. The old owner keeps their grant, so their object access, but no longer manages the bucket. The transfer is audited (`UPDATE bucket`, `changes.ownerId`) and emitted as `file-service.bucket.owner-changed`; a declared bucket's owner is its service's account, so transferring one is `409 bucket_declared`. The lifecycle policy (`/lifecycle`) is a bucket setting and takes the same check — no `file-service.objects.*` permission, and a public bucket's policy is not public. `validateBucketManagement` in `utils/bucketAccess.ts`. A bucket a service declared (`serviceId` set) cannot be deleted while declared, and its description and the service's own grant are the declaration's: changing them is `409 bucket_declared` (see [registry.md](registry.md#declared-buckets)).

**Deleting a bucket** sets its `deletedAt` (a conditional update: of two deletes or a delete and an update racing, the loser gets `404`, and only one audit entry and event is written), then enqueues the `bucket-cleanup` job, which releases its versions' blob refs in batches. Every 6 hours the `bucket-cleanup-reconcile` job gives a cleanup run to every bucket deleted over an hour ago that still has live versions holding refs, so a lost or failed enqueue only delays the release. Bucket cleanup releases nothing in a bucket that is not deleted.

`PUT /buckets/:name` with `storageQuotaBytes: null` clears the quota, as `null` on create sets none. An upload (`PUT /objects/*objectKey`) whose `Content-Length`, with the bucket's usage and the active multipart uploads' `expectedSize`s, would pass the quota is `507 insufficient_storage` before its body is read (`assertUploadMayFit`); in a bucket without versioning the current version it would replace counts as room. The length is the whole request body, a little more than the file, so only a file within that margin of the quota is refused early that would otherwise fit; the authoritative check stays in the write's transaction. A bucket's `rateLimitConfig` is a per-user token bucket applied on top of the general limiter; going over it answers like the general limiter — `429 too_many_requests` with `retry_after`, `Retry-After` and `X-RateLimit-Limit/Remaining/Reset` (for the bucket's limit).

## Storage Architecture

Files stored content-addressably by SHA-256 hash at a **global** path:
- `{FILE_SERVICE_STORAGE_PATH}/blobs/{hash[0:2]}/{hash[2:4]}/{hash}`
- On-disk format: 5-byte magic header `VFBE\x01` + AES-256-GCM ciphertext + 16-byte auth tag.
- `ContentBlob` table owns physical storage and reference count; `Object` rows are pointers via the required `contentBlobHash` FK.
- **Writing a blob.** A write encrypts to a staged temp file (`saveBlobStream`), then attaches it in its transaction (`contentBlobs.attach`): under a per-hash advisory lock (`lockHash`) held to commit, the write that creates the `ContentBlob` row moves its staged file to the blob path; any other — concurrent or later — finds the row, shares its file and key material, and drops its own. So identical content uploaded at the same moment is stored once and both writes succeed. A write that fails calls `contentBlobs.releaseStaged`, which, under the same lock, deletes the file at the blob path only if no row stands for it. Orphan cleanup and disk reconciliation unlink a file under that lock too, after re-checking the row.
- **Reference counts.** `refCount` is not clamped: a release counted twice fails the `ref_count >= 0` CHECK and rolls its transaction back rather than hiding the drift. Orphan cleanup (`claimOrphan`) also counts the blob's live versions before deleting a row with `refCount` 0; if any remain (a deleted row would null their content through the foreign key), it logs an error, sets `refCount` to that count and leaves the blob.
- Every blob is encrypted at rest — `ContentBlob.wrappedDek`, `iv`, and `masterKeyVersion` are non-nullable.
- The wrapped DEK is **AAD-bound to the blob hash**: an attacker with DB write access cannot swap `(wrappedDek, iv, masterKeyVersion)` between rows — GCM verification fails when the AAD doesn't match the stored `hash`.
- In-flight multipart parts are also encrypted at rest under a per-upload staging DEK (wrapped under the master key with AAD = upload id), with a fresh per-part IV prepended to each part file (`iv(12) || ciphertext || tag(16)`) and AAD `{uploadId}|{partNumber}`, so a part file moved to another part or upload fails to decrypt. On `complete`, parts are decrypted while concatenating, each part's plaintext MD5 is checked against its recorded etag, and the concatenated plaintext is re-encrypted under the final blob DEK; a part that fails either check is `422 part_integrity_mismatch`. Parts staged before parts were bound (`multipart_parts.aad_bound = false`) still decrypt without AAD.

## Object model

Three layers, fully normalized:

- **`Object`** — an identity row: a UUID `id` + a name (`objectKey`) within a bucket. Owns nothing but the name, `deleteAfter`, and thumbnail linkage. No size, content-type, etag, or blob pointer.
- **`ObjectVersion`** — the content-bearing row. UUID `id` (exposed on the wire as `versionId`). One per upload. Carries `contentType`, `etag`, `metadata`, `tags`, plus a `contentBlobHash` FK. Always created by every write.
- **`ContentBlob`** — the physical bytes on disk. Owns `sizeBytes`, filesystem path, and encryption key material. Referenced by zero or more `ObjectVersion` rows.

The current state of an Object is the `ObjectVersion` with `isCurrent=true AND deletedAt IS NULL`. Reads join through the current version to get size, etag, and content-type.

### Object metadata

`metadata` is a flat JSON object: at most 100 keys of up to 255 characters, values a string (≤ 10,000 chars), number, boolean, null or an array of those (≤ 100 items), and at most 100 KB serialized. The same `metadataSchema` (`routes/v1/files/buckets/bucket/objects/schemas.ts`) checks it wherever it is set — the `X-Metadata` upload header, `PATCH /objects/by-id/:id`, and multipart initiate.

### Object tags

`tags` is a list of at most 50 non-empty strings of up to 128 characters, set on upload, by
`PATCH /objects/by-id/:id` or at multipart initiate. JSON bodies take them as is. The upload's
`X-Tags` header (`extractTagsFromRequest`) has two forms:

- A value starting with `[` is a JSON array of strings, taken as is like a JSON body — so tags may
  hold commas and any character. A header value must be ASCII, so characters past `~` are sent as
  `\uXXXX` escapes, as for `X-Metadata`. Invalid JSON, or an entry that is not a non-empty string,
  is `400 invalid_request`; it never falls back to the comma form. The SDK and the admin UI always
  send this form.
- Any other value is comma-separated: each tag trimmed, empty ones dropped. Such a tag cannot hold
  a comma, and the first cannot start with `[` (the value would be read as JSON).

### Content type

An object's content type is stored as a single `type/subtype`, lowercased, with at most a `charset`
parameter (`normalizeContentType` in `utils/contentType.ts`) — on upload, presigned upload, PATCH and
multipart initiate alike; anything else is `400`. A browser reads `image/png, text/html` as HTML, so
inline-safety is decided on the parsed type, and every download (authenticated, public, signed,
version, archive) carries `Content-Security-Policy: sandbox; default-src 'none'`.

Every `Content-Disposition` — downloads, archives, the share probe — comes from
`contentDisposition` in `objects/utils.ts`: control characters, `"` and `\` become `_`; `filename=`
is an ASCII fallback (anything outside printable ASCII also `_`), and `filename*=UTF-8''…` carries
the real name, RFC 5987-encoded. A header value must be Latin-1, so a raw `Отчёт.zip` would
otherwise fail the response.

## Reads-by-key, writes-by-id

Routes split by intent:

- **Reads** — `GET/HEAD/PUT /buckets/:name/objects/*objectKey` — addressed by object key. URLs stay human-readable, cache-friendly, and S3-like. Upload (`PUT`) stays key-based because it is the identity-creator.
- **Mutations** — `/buckets/:name/objects/by-id/:id/...` — addressed by the object's UUID `id`. Covers `PATCH` (rename + metadata), `DELETE`, version list/get/restore/delete, and `POST /presign`.

This avoids a splat-vs-literal routing collision for nested paths (versions, presign) and gives callers a stable identifier that survives renames.

**Reserved keys.** The objects router answers some key-shaped paths itself: `GET/HEAD /objects/prefixes` is the prefix listing, and `/objects/by-id/…` and `/objects/by-key/…` are the id- and key-addressed routes. An object stored under one of those keys could not be read back by key, so every write that names a key refuses `prefixes` and any key starting with `by-id/` or `by-key/`, in any letter case (routes match case-insensitively), with `400 reserved_object_key`; so too any key starting with `.thumbnails/`, where generated thumbnails live (see [Thumbnails](#thumbnails)): upload, multipart initiate, a `PATCH` rename, minting a presigned write URL, and a write through one (`assertObjectKeyNotReserved` in `objects/utils.ts`). `bulk-delete` and `purge-non-current-versions` are POST-only, so they shadow no key. Near misses (`prefixes.txt`, `by-id`, `docs/by-id/x`) are ordinary keys.

## Versioning

Opt-in per bucket via `Bucket.versioningEnabled`.

- **Versioning off**: upload deletes the prior current `ObjectVersion` (releasing its blob ref) and inserts a new one. Only one version row per object at any time.
- **Versioning on**: upload flips the prior `isCurrent=false` (keeping its row and blob ref) and inserts a new current version. Delete inserts a delete-marker version (`contentBlobHash=null`). Restore copies an old version back to current, holding a new ref.
- Download accepts `?versionId=UUID` for non-current versions.
- Uploads, deletes, restores and PATCH with `createNewVersion` read the versioning setting under the bucket row's lock (`db.buckets.lockForWrite`), not when the request arrived; disabling versioning checks for history under the same lock. A restore that finds it off is `400 versioning_disabled`; a branching PATCH edits in place.
- **Lock order** for every object write: the object row(s) → the bucket row → the content blob (its advisory lock, then its row). A new key is first serialized on an advisory lock for `(bucket, key)`, so two uploads to a key with no object yet queue rather than collide; the second overwrites the first. Releases take the same order — a version's delete or expiry, the history purge and the purge of soft-deleted objects lock the bucket before the blobs they decrement and refund it after. A transaction touching several blobs locks them in hash order (`contentBlobs.lockInOrder`) before changing any: an upload or thumbnail that replaces content locks the blobs it releases around its `attach`, and batch deletes and purges lock every blob of the batch up front; bucket cleanup, which leaves the deleted bucket's row alone, locks just the blobs.
- Usage counts every retained version: a versioned upload, a restore and a PATCH with `createNewVersion` each charge the content's size, and deleting, purging or expiring a version refunds it.
- Restore undeletes: after a versioned bucket's DELETE (a delete marker, the Object row soft-deleted) the history stays readable, and restoring a version brings the object back under its key and id (409 if a live object has taken the key since). `GET /buckets/:name/objects?deleted=true` lists the deleted objects to restore — soft-deleted rows whose current version is a delete marker — with the list's filters, sorts (but `sizeBytes`) and cursor; a bucket without versioning keeps no version to restore, so lists none.
- The versions list and a version's detail (`GET /buckets/:name/objects/by-id/:id/versions[/:versionId]`) resolve each `createdBy` to `createdByEmail` / `createdByName` and a `creator` ref with one batched user lookup (`withUserRefs`, as the permissions list and grant do); all three are null when the user no longer resolves; for a caller served only because the bucket is public they are null and so is `createdBy`. The deleted-objects list names `deletedByUser` behind the same gate.

## Refcount rule

An `ObjectVersion` row holds exactly one reference on its `ContentBlob` iff:
`deletedAt IS NULL` ∧ `isDeleteMarker = false` ∧ `contentBlobHash IS NOT NULL`.

Every state transition in `upsertWithBlob`, `removeObjectById`, `removeExpiredObjects`, `softDelete`, and `restoreObjectVersion` preserves that invariant. A version's soft-delete (`markDeleted`) is a conditional update, so of a user's delete, the history purge and the lifecycle sweep racing on one version, only the first releases its ref. The purge of soft-deleted objects marks their live versions deleted with the same condition and releases only the versions it transitioned, and a non-versioned delete removes the current version only while it is still live, so neither releases a version the history purge, version expiry or bucket cleanup released first. Deleting an object of a bucket that is itself deleted is `409` (the bucket's cleanup releases its refs).

## Thumbnails

With `autoThumbnails` on, image content written to an object — by upload, multipart complete, a
presigned write or a restore of an image version — queues the `thumbnail-generation` worker, which stores `thumb`, `small` and `medium` WebP renditions as
objects linked to the parent by `thumbnailFor`, under `.thumbnails/{parentId}/{size}`. They are
served only through the parent — `GET /buckets/:name/objects/*objectKey?thumbnail=small`, whose
`X-Object-Id` is the parent's — never under their own key or id (by-id reads, presigned URLs,
shares, notification attachments), are left out of lists, and are not charged to the bucket's usage. The
worker writes them under the parent's row lock, and only while the parent's current content is
the one it rendered. While `autoThumbnails` is off, `?thumbnail=` is `404` even for an object
whose thumbnails were generated before.

A thumbnail lives only as long as its parent's current content: deleting the parent (by id, in
bulk or by the lifecycle sweep) hard-deletes its thumbnails in the same transaction, releasing
their blob refs, even in a versioned bucket where the parent's history stays. Restoring a version
queues new ones rather than bringing old ones back. Purging a soft-deleted parent releases the
refs of any thumbnails still attached to it. Writing new content to the parent — any write path
(`upsertWithBlob`) or a version restore — hard-deletes the old content's thumbnails in its
transaction too, in a versioned bucket or not, and the blobs they released are queued for cleanup.
New image content then gets new ones from the worker; anything else gets none, so `?thumbnail=`
is `404` until (and unless) they are generated.

## ETag / Conditional Requests

- Downloads — `GET` / `HEAD` by key, a version by id (and signed URLs) — evaluate the preconditions of RFC 9110 §13.2.2 in its order: `If-Match` (strong comparison, so a `W/` tag never matches) or else `If-Unmodified-Since` is `412`; then `If-None-Match` (weak comparison) or else `If-Modified-Since` is `304`, which carries `ETag`, `Last-Modified` and `Cache-Control`. `utils/conditionalRequests.ts`; `prepareDownload` in `objects/utils.ts` sets a download's headers for `GET` and `HEAD` alike, so `HEAD` (with `?versionId=` / `?thumbnail=` too) answers with exactly the headers `GET` would.
- On `PUT`, `If-Match` (strong) and `If-None-Match` (`*` is atomic-create; a list of tags refuses a write over content with one of them, compared weakly) are checked under the object's row lock in the write's transaction (`upsertWithBlob`), after the idempotency replay lookup.
- An error response never keeps a download's headers: `writeError` (`utils/errors.ts`) drops `Content-Disposition`, `ETag`, `Last-Modified` and `Content-Range` (a `416` sets its own `bytes */size`) and answers `Content-Type: application/json` with `Cache-Control: no-store`. Once headers are out, the connection is reset instead.
- `Cache-Control`: `public` only for a public bucket, `private` otherwise; a key's current content is `no-cache` (revalidate with the ETag), a pinned version (`?versionId=`, the by-id version download) `max-age=31536000, immutable`.
- Responses include `ETag: "<md5-hex>"`.
- Multipart ETag suffixes with `-{partCount}` (AWS S3-style).

## Range requests

Object downloads — by key (authenticated or public bucket), a version by id, and a signed URL (which
share downloads redirect to) — take one byte range: `Range: bytes=a-b`, `bytes=a-` or `bytes=-n`,
answered `206 Partial Content` with `Content-Range`, or `416` with `Content-Range: bytes */size` when
it starts past the end. Several ranges, another unit or a malformed header get the whole body (`200`);
every download carries `Accept-Ranges: bytes`. The preconditions are checked first; `If-Range` sends
the range only if it strongly matches the `ETag`, or equals `Last-Modified` where the response has one
and that is at least a second older than the response's `Date` (a strong date validator, RFC 9110
§8.8.2.2) — otherwise the whole body is sent. Archives serve no ranges. `sendBlobBody` in
`routes/v1/files/buckets/bucket/objects/utils.ts`; parsing in `utils/httpRange.ts`.

Blobs are one AES-256-GCM stream, and GCM is CTR underneath, so a range is decrypted from its offset:
`createRangeDecipher` (`utils/encryption.ts`) seeds AES-256-CTR with the counter block for the range's
first AES block (`iv || uint32be(2 + block)`) and drops the bytes before the start
(`openBlobRangeStream`). The GCM tag covers the whole blob, so a range of a blob streamed this way is
not authenticated. Blobs up to 16 MiB (`INTEGRITY_VERIFY_MAX_BYTES`) are still decrypted and verified
whole, then sliced; only ranges of larger blobs — whose full downloads already stream before the tag
is checked — skip verification. The plaintext held this way counts against one process-wide budget,
`FILE_SERVICE_VERIFIED_READ_BUDGET_MB` (default 256): a download that finds no room waits, in arrival
order, up to `FILE_SERVICE_VERIFIED_READ_WAIT_SECONDS` and is then `503 temporarily_unavailable`
(`ByteBudget`, `utils/byteBudget.ts`). A stream that fails is logged (`Blob stream failed`, with the
blob's hash), and a response cut off after its headers still writes its access-log row, with the error.

A share's `GET /v1/files/shared/:token` counts a download per request, a ranged one included; a player
seeking through an uncapped share should keep using the signed URL it was redirected to. A capped
share's signed URL serves one request (see *Shares*), so its content has to be fetched whole.

## Pagination

All list endpoints (`GET /buckets`, `/buckets/:name/objects`, `/objects/prefixes`, `/objects/by-id/:id/versions`, `/buckets/:name/permissions`) use **cursor-based keyset pagination**. Response shape: `{ data, hasMore, limit, nextCursor }`. Cursors are HMAC-signed opaque strings (the shared `CURSOR_SIGNING_KEY_V{n}`) bound to the list that minted them (its request path) and the requested sort+direction; tampering, or replay on another list or sort, returns `400 invalid_cursor`. No `total` count — `COUNT(*)` is not cheap at scale.

Pass `cursor=<nextCursor>` from the prior page to advance. First request omits the cursor.

Sorting by a column that can be NULL — a bucket's `description`, a share's `expiresAt` — pages
through the NULLs too (last ascending, first descending): the list's schema names the column in
`nullableSortFields` and the shared `buildCursorWhere` handles it.

## Idempotent Uploads

`PUT /buckets/:name/objects/*objectKey` and `POST /buckets/:name/multipart/:uploadId/complete` **require** an `Idempotency-Key` header. Missing or empty → `400 idempotency_key_required`.

- **Storage**: Postgres `IdempotencyRecord` (24h TTL) is the source of truth for replay; Redis `SET NX` (60s TTL) is a concurrency guard only. Lookups filter `expiresAt > now()` so swept/expired rows don't block legitimate reuse. The record is written in the write's own transaction (the handler calls the `persist` it is given), so a request either commits its object and its record together or neither: a retry after any failure runs again rather than writing a second version.
- **Scope**: `userId + bucketId + endpoint + key` — different users never share a replay cache even if they pick the same key.
- **Request hash**: PUT = `sha256(bucketId|objectKey|blobHash|canonical(metadata)|canonical(sortedTags))`. Multipart complete = `sha256(uploadId|canonical(sortedParts))`. `canonical()` sorts object keys recursively so differently-ordered metadata hashes identically.
- **Replay** (same key + same hash) → returns cached response + `Idempotency-Replay: true`.
- **Conflict** (same key + different hash) → `422 idempotency_key_conflict`.
- **Mid-flight** (same key, concurrent) → `409 idempotency_request_in_progress`.

The `withIdempotency()` helper in `src/utils/uploadIdempotency.ts` wraps the upload and multipart-complete handlers. Failures don't cache — the Redis claim is released so retries can start fresh. The claim (60s TTL) is renewed every 5s while its request runs, so it lapses only when the process holding it is gone, not when a request is slow; claims are released only by their holder. Expired records are purged hourly by the `idempotency-sweep` BullMQ worker.

**Multipart complete** is also exclusive per upload, whatever the key (`withExclusiveClaim`, Redis key `file-service:multipart-complete:{uploadId}`, renewed the same way and released only after the result is stored): any other complete of the upload while one runs is `409 multipart_complete_in_progress`. Afterwards, a complete under a new key with the same parts gets the stored result of the first (`findStoredResponse`, for the 24h the record lives); different parts are `404`. Should the claim be lost anyway (Redis restart), `markCompleted` is conditional, so a second assembly's transaction rolls back rather than writing the object twice.

Multipart initiate (returns a cheap `uploadId`) and part-upload (already idempotent on `(uploadId, partNumber)`) are **not** covered.

## Multipart Uploads

S3-style flow — safe for very large files (no memory ceiling). Every route
lives under a single `/multipart` namespace; the object key travels in the
initiate body so no splat is needed:

1. `POST /buckets/:name/multipart` `{ objectKey, contentType, expectedSize?, metadata?, tags? }` → `{ uploadId }` (`metadata` has the same limits as on upload — see [Object metadata](#object-metadata))
2. `PUT /buckets/:name/multipart/:uploadId/parts/:partNumber` (binary stream, stored byte for byte whatever its `Content-Type` — no body parser runs on this route)
3. `POST /buckets/:name/multipart/:uploadId/complete` `{ parts: [{partNumber, etag}] }` — when `expectedSize` was given at initiate, parts totalling any other size are `400 size_mismatch` (the upload stays active)
4. `DELETE /buckets/:name/multipart/:uploadId` — abort. Takes `file-service.objects.delete` and the bucket's delete grant (not the write grant), and works on a retired bucket, where deletes go on

**Limits.** A part is capped at `FILE_SERVICE_MAX_UPLOAD_SIZE_MB`, and the bytes staged for an
upload are capped as each part arrives, not only at complete: a part that would take the
upload's parts (the others plus this one; a part sent again replaces itself) past its
`expectedSize` is `413 exceeds_expected_size`, past the largest object a bucket can store is
`413 object_too_large`, and past the bucket's remaining quota is `507 insufficient_storage`
(`assertMultipartFits` in `multipart/utils.ts`). With a `Content-Length` the part is refused
before its body is read; otherwise it is staged, checked under the upload's row lock, and its
file deleted. Initiate applies the same size checks to `expectedSize`, and complete checks the
total again. The largest object is `MAX_BLOB_BYTES` in `utils/encryption.ts`:
68,719,476,704 bytes, 32 short of 64 GiB, because a blob is one AES-256-GCM stream, whose 32-bit
block counter starts at 2 for the data (`createRangeDecipher`). Single-request uploads, capped
at `FILE_SERVICE_MAX_UPLOAD_SIZE_MB` (at most 10 GiB), never approach it. A user may have
`FILE_SERVICE_MAX_ACTIVE_MULTIPART_UPLOADS` (default 100) uploads in progress in a bucket;
initiating another is `409 too_many_multipart_uploads` until one is completed, aborted or
expires.

**Staging against the quota.** In a bucket with a quota, an active upload (not completed, aborted
or expired) holds its `expectedSize` against the quota. Initiate is `507 insufficient_storage`
unless the bucket's usage, the `expectedSize`s of its active uploads — every user's — and the new
upload's `expectedSize` together fit the quota. The check runs under a per-bucket advisory lock
taken by every initiate (`initiate` in `utils/db/multipartUploads.ts`), so concurrent initiates
see each other's reservations. An upload without an `expectedSize` holds nothing: it is refused at
initiate only when the others' already pass the quota, and its parts are checked against the
quota as they arrive, as above. Nothing is reserved in `currentUsageBytes`; the bytes are charged
when the upload completes, and a reservation ends when the upload does. Every other write's quota
check (`reserveQuota`, under the same advisory lock) counts active uploads' `expectedSize`s too,
so a direct upload cannot take the room a multipart upload holds; the completing upload's own
reservation is left out of its check.

**Parts and complete.** A part PUT is refused with `400 upload_not_active` when the upload was
completed, aborted or expired, checked again under the upload's row lock when the part is recorded
(its staged file is deleted). While a complete of the upload runs, a part PUT is
`409 multipart_complete_in_progress`: the complete reads the parts under a share lock on the same
row, and a part sent again would delete the file it replaces. Listing an upload's parts
(`GET …/multipart/:uploadId`) is, like its other routes, for the user who initiated it or a
`file-service.admin` holder (`403`). Complete writes the object's own audit entry (`object`,
`CREATE` or `UPDATE`) besides the `multipartUpload` one, and broadcasts the object's cache
invalidation, as a direct upload does.

Parts staged at `{storage}/multipart/{uploadId}/{partNumber}.{nonce}`. Expired uploads swept hourly by `multipart-sweep` worker. The same sweep deletes the files core writes in `FILE_SERVICE_TEMP_PATH` (`upload-*`, `signed-upload-*`, `mp-complete-*`: staged uploads and multer spool files) left by a crash, once older than a day or the multipart TTL, whichever is longer; anything else there is left alone. Each process sweeps only when it runs the job, so the path should be local to the worker or shared by all.

`FILE_SERVICE_TEMP_PATH` holds plaintext. multer spools a single-request upload (`PUT /objects/*objectKey`) there unencrypted while it is processed (`objects/object/middleware.ts`; a full disk there is `507 insufficient_storage`, any other failure to write it a `500` that names no path), until it has been encrypted into the blob store, and a crash can leave the spool file there until the sweep above. The other files core stages there are already encrypted. Put the path on an encrypted volume or a tmpfs.

## Presigned URLs

Stateless HMAC-SHA256 tokens — no DB rows per URL (archives are the one exception — see below). Key rotation via `FILE_SERVICE_SIGNING_KEY_V{N}` + `FILE_SERVICE_ACTIVE_SIGNING_KEY_VERSION`.

- `POST /buckets/:name/objects/by-id/:id/presign` `{ operation: "read"|"write", expiresInSeconds }` → `{ url, expiresAt }`
- `GET/PUT /v1/files/signed/objects/:bucket/by-id/:id?op=…&expires=TS&nonce=N&v=V&sig=S` — no auth middleware, HMAC-verified per request, before the per-bucket rate limiter looks the bucket up. The HMAC binds the bucket and object id, so the URL survives a rename; a presigned PUT writes to the object by id under its row lock, under the key it holds then, so a rename while the body streams is followed and a delete meanwhile is `404`. No body parser runs under `/signed`, so a presigned PUT is stored byte for byte even as `application/json` or a form; should a parsed body ever reach a streamed upload, it is refused rather than stored empty (`assertUnreadBody` in `utils/storage.ts`).
- The query is parsed with `signedQuerySchema` (`routes/v1/files/signed/schemas.ts`): a missing parameter, or a `filename` over 255 characters, is `400`. Before the HMAC is checked, `expires` and `v` must be digits, `nonce` base64url, and `share`, `by` and `version` (when present) UUIDs; anything else is the same `403` as a bad signature. The canonical string joins fields with `|`, so this keeps a parameter from carrying another's segment.
- **`filename`** is bound into the HMAC when it is set at signing (share URLs carry the share's `urlFilename` this way; the segment is URI-encoded, so it can't forge another). A `filename` the signature doesn't cover — added to a URL afterwards, or on a URL from before filenames were signed — is ignored; changing or stripping a signed one is `403`. `disposition=attachment` stays an unsigned hint: it can only force attachment.
- **The signer's access** — a URL with `by` (every one `POST …/presign` mints) works only while that user could still do what it does: on each request the user must be active and hold `file-service.objects.read` (`GET`/`HEAD`) or `.write` (`PUT`) plus the matching active bucket grant, or `file-service.admin` (`assertSignerMayAccess` in `routes/v1/files/signed/utils.ts`, through `canReadBucket`/`canWriteBucket`). Their permissions are taken as a session in the bucket's organization would have them — global roles, plus that organization's while they are a member and it is active; for a bucket outside any organization, global roles plus those of every active organization they belong to. A delegated token's scope ceiling is not recorded in the URL, so it is not re-applied. An archive URL is checked the same way against the archive's creator. Share URLs follow the share instead (below); URLs core signs for itself (profile photos) carry no `by`.
- `HEAD` on a signed object or archive URL runs the same checks and sends `GET`'s headers (`Content-Length`, `Accept-Ranges`, `ETag`, `Last-Modified`, `Content-Disposition`, CSP, `nosniff`; archives have no length) with no body, no audit entry, and no spent nonce.
- Access-log rows: `PRESIGNED_DOWNLOAD`, `PRESIGNED_UPLOAD` and `ARCHIVE_DOWNLOAD`, with the bucket (and object). A presigned upload also broadcasts the object's cache invalidation, as an authenticated upload does.
- The per-bucket CORS and rate-limit middleware cache configs by bucket name in a bounded LRU (`utils/boundedCache.ts`, 1000 entries, 60s), dropped on `cacheBroadcast` invalidation. The config's values are written into response headers as stored, so at write time an origin must be `scheme://host[:port]` or `*` and a header name an RFC 9110 token (`400` otherwise). A bucket's CORS config also answers preflights for its `objects`, `archives` and `multipart` routes (mounted in `app.ts` ahead of the global CORS middleware, which would otherwise end every preflight).

## Archive Downloads

Folder (prefix) or multi-select (by keys) download as a streaming zip/tar. `ArchiveRequest` rows snapshot each resolved object's current version at create time (`archive_request_objects.version_id`); the download URL is the only way to consume them, so the same flow serves both "download now" and "share a link". The download streams exactly those versions: an entry whose object has since been overwritten (versioned or not), deleted or purged is left out — its content is no longer the object's, and a non-versioned overwrite has released it — and objects added under a prefix later are not included. With no entry left the download is `410 archive_gone`. Entries are named by the object's key at download time.

- `POST /buckets/:name/archives` `{ prefix? | keys?, format?, expiresInSeconds?, filename? }` → `{ id, url, expiresAt, objectCount, totalSizeBytes, format, filename }`
- `GET /v1/files/signed/archives/:id?op=archive&...` — signature-verified; streams the zip with `Content-Disposition: attachment`. The HMAC binds the archive's bucket, which comes from its row, so the row is read first — but a missing archive is verified against a bucket name no signature matches, so it gets exactly the `403` (or expired-URL `403`) a wrong signature would: the URL is no oracle for archive ids. Only an `id` that is not a UUID is `404`. A blob that is missing or fails verification is left out and listed in a trailing `MISSING_FILES.txt` rather than aborting the whole archive: before an entry is appended, a blob up to 16 MiB is read and verified whole (under the same budget as downloads), a larger one's file opened and its header checked. A large blob whose tag fails mid-stream still aborts the archive.
- Caps: `FILE_SERVICE_MAX_ARCHIVE_OBJECTS` (default 10000), `FILE_SERVICE_MAX_ARCHIVE_TOTAL_BYTES` (default 50 GiB). Operators can raise both. The byte cap is checked again at download against the entries still served (`400 archive_too_large`, before any byte is sent), so lowering it applies to archives already created. `expiresInSeconds` is capped by `FILE_SERVICE_MAX_PRESIGN_TTL_SECONDS` (`400 invalid_expiration`), checked before anything is written; the URL is signed inside the create transaction, so a failure leaves no archive row or audit entry.
- Audit: `CREATE archiveRequest` on create, `CREATE archiveDownload` on every stream.
- Retention: archives are streamed on demand, so nothing is stored but the row and its snapshot. The daily `archive-sweep` worker hard-deletes archive requests whose `expiresAt` is more than `FILE_SERVICE_SHARE_RETENTION_DAYS` past — the same grace the share sweep gives a share, so a share listing keeps its archive's details. The snapshot rows and any shares still pointing at the archive cascade; such a share has answered the uniform 404 since the archive expired. In the delete's transaction, a share that is neither revoked nor expired is first revoked by the system user, audited and emitted like any revoke (`reason: "archive_expired"`), and each batch writes one `DELETE archiveSweep` entry per bucket listing the archives and the ids of the shares that went with them.

## Shares

DB-backed, revocable download links that sit alongside (not replacing) stateless presigned URLs. Presigned URLs stay right for internal/ephemeral callers (product images, labels, thumbnails); shares are the external-sharing surface where revocation, password gating, download caps, and TTL matter.

- **`Share` model** — one row per link. Two kinds:
  - `kind=OBJECT` — points at a single object (`objectId`), with an optional version pin (`versionId`). When `versionId` is null the share tracks the current version; when set, the signed URL a download mints carries it (`version=`, HMAC-bound) and that version is served.
  - `kind=ARCHIVE` — points at an `ArchiveRequest` that the server creates in the same transaction as the share, from either a prefix or an explicit key list. One-step UX: callers don't create the archive separately. The archive expires a minute after the share; a PATCH to a later expiry extends it. A share whose archive has expired or gone is the uniform 404, counted as no download.
  - A share pinned to a delete marker is refused (`400 cannot_share_delete_marker`).
- **Expiry** — every share expires. `expiresAt` must be in the future and within `FILE_SERVICE_MAX_SHARE_TTL_SECONDS`; omitted on create, or `null` on PATCH, it is that long from now. Shares created before this rule had none; the share sweep fills them in as `created_at + FILE_SERVICE_MAX_SHARE_TTL_SECONDS` on each run (a lookup on the `expires_at` index once none are left), so one older than the cap stops working at the sweep's next run.
- **Tokens** — 18 random bytes base64url-encoded. Opaque and unguessable; no caller-supplied alternative (rejected by design — a readable slug is brute-forceable and would regress confidentiality for unpassworded shares).
- **Token visibility** — the token is a bearer credential, so `GET /buckets/:name/shares` and `GET /buckets/:name/shares/by-id/:id` return `token` and `url` only to the share's creator and to callers with write access to the bucket (`canWriteBucket`, `utils/bucketAccess.ts`); any other reader sees `null` for both, decided per row on the list. Create and PATCH responses always include them.
- **URL cosmetics** — the `urlFilename` field is a cosmetic suffix appended to the public URL. The server ignores it when resolving a share — only the token identifies the row. Purpose is browser "Save As" defaults and nicer-looking shared links.
- **Public download** — `GET /v1/files/shared/:token` or `/v1/files/shared/:token/:filename` (no auth) → `302` redirect to a short-TTL presigned URL minted via `utils/presigning.ts`. For object shares the target is `/v1/files/signed/objects/:bucket/by-id/:id`; for archive shares `/v1/files/signed/archives/:id`. The existing signed-download handlers do the actual streaming — this layer never duplicates streaming logic.
- **Single-use URLs for capped shares** — counting mints alone would let a `maxDownloads: 1` share's signed URL be fetched any number of times until it expires. So for a share with `maxDownloads`, the URL's random `nonce` (already HMAC-bound) is stored in Redis at mint, as `file-service:share-url:{shareId}:{nonce}` with the URL's lifetime plus the clock skew (`utils/shareUrlNonces.ts`), and the signed route deletes it with `GETDEL` (`auditAndSpendShareUrl`, `routes/v1/files/signed/utils.ts`) once the content is resolved and about to be sent — for an object after its blob is opened (`beforeBody` of `sendBlobBody`), for an archive just before the stream starts. It is spent as the last step of the transaction that writes the download's audit entry, so a URL already used rolls the entry back. Redis can't join that transaction: when the commit fails after the nonce was spent, the nonce is stored again (best-effort), so a download that never started doesn't burn the URL; `GETDEL` has already decided between concurrent hits, and only the winner gives it back, so the URL still serves once. A URL whose nonce is missing, spent or expired is the same `403` as a bad signature. So a `Range` `GET` spends it, but a `HEAD` (its own route) or a request that fails first (`404`, `416`, a small blob failing its integrity check) does not; `GETDEL` keeps two concurrent `GET`s from both being served. Whether a URL is single-use follows the share's current `maxDownloads`, so URLs minted before a cap was added are refused. Both minting and serving fail closed (`503`) without Redis, and minting happens before the download is counted, so an outage costs no download. Uncapped shares, direct presigned reads and presigned writes are unchanged: replayable until expiry.
- **Status probe** — `HEAD /v1/files/shared/:token` (or `/:token/:filename`) answers without counting a download or minting a URL: `200` for an open share, with `Content-Type`, `Content-Disposition` (the filename GET would use), `X-Share-Kind`, `X-Share-Size-Bytes` (objects only), `X-Share-Downloads-Remaining` and `X-Share-Expires-At` (each omitted when unlimited), all listed in `Access-Control-Expose-Headers`; a `401` for a password share (no details until unlocked); the uniform `404` otherwise. The route is registered before GET because Express would otherwise answer HEAD with the GET handler — which counts a download.
- **Password** — `passwordHash` is scrypt (`utils/password.ts`). Unlock flow: `POST /v1/files/shared/:token/unlock { password }` → `{ url, expiresAt }` on success (`password` may be left out for a share without one, which unlocks as is; a password share without it is `400`); rate-limited per `(token, ip)` via Redis (`utils/shareUnlockLimiter.ts`), and for a password share also backed off per token from any address (`shareUnlockBackoff` in `middleware/rateLimit.ts`: 10 attempts, then a delay doubling from 1s to 15 min, reset by a correct password. Anyone with the link can start it, so during a delay an address's first attempt in its `(token, ip)` window is still verified — a correct password unlocks, a wrong one gets the same 429 and lengthens the delay — and later attempts from that address wait it out unverified: recipients are not locked out, while a guesser needs a fresh address per guess during the delay), both failing closed (`503 temporarily_unavailable`) when Redis is unavailable.
- **Password-share UI redirect** — share URLs always point at core so programmatic clients (curl, scripts) can `POST /v1/files/shared/:token/unlock` directly against the URL's host. A password-protected share is content-negotiated: a caller that prefers HTML (a browser) gets a 302 to `${FILE_SERVICE_SHARE_UI_BASE_URL}/shared/:token` (the unlock page; the base defaults to `UI_BASE_URL`); one that asks for JSON gets a 401 `{ requiresPassword: true }`.
- **Download caps** — atomic `UPDATE ... RETURNING` (`db.shares.atomicIncrementDownloads`) guarantees `maxDownloads=3` + concurrent requests = exactly 3 successes.
- **Status** — a share's `status` in the bucket's share list and detail is `active`, `revoked`, `creator_inactive` (its creator is deactivated, so it no longer serves), `expired` or `exhausted`, checked in that order.
- **Managing shares takes a grant** — creating, listing, reading, editing and revoking shares take an active grant with `canRead` (or `file-service.admin`), on a public bucket too: that anyone may download from it is no grant (`getGrantedBucket`, `utils/bucketAccess.ts`).
- **Editing and revoking** — `PATCH` / `DELETE /buckets/:name/shares/by-id/:id` take that read grant — so a share's creator whose grant was revoked can no longer extend it — plus the write (edit) or delete (revoke) grant for anyone but the share's creator; that permission check comes first (`403`). An edit that makes the share reach further — removing its password, removing or raising its download cap, or moving its expiry later (`expiresAt: null` included) — is further limited to the share's creator, a caller who manages the bucket (`canManageBucket`: its owner with an active grant and `file-service.buckets.write`) and `file-service.admin`: another bucket writer gets `403`, though they may still tighten the share, make other edits, and revoke it. Shares go on in a retired bucket, so editing one there is allowed. Editing a revoked share is `409 share_revoked`; revoking one again is an idempotent `204`.
- **Uniform 404** — missing / revoked / expired / exhausted all return the same 404 on the public endpoint so it can't be used as a validity oracle.
- **Creator's access** — a share outlives its creator's access to the bucket: it keeps serving after their grant is revoked, their membership removed or the bucket handed to another owner, so that links already sent keep working. To end them with the access, `DELETE /buckets/:name/permissions/:userId?revokeShares=true` revokes the user's live shares on that bucket, and `DELETE /v1/admin/organizations/:id/members/:userId?revokeShares=true` those on the organization's buckets, in the same transaction, each audited (`DELETE share`, `reason: "permission_revoked"` / `"organization_member_removed"`) and emitted (`file-service.share.revoked`) like any revoke (`revokeCreatorSharesTx` in `utils/shareRevocation.ts`). Both default to `false`.
- **Creator deactivated** — a share serves only while the user who created it is active: once deactivated, the public endpoint is the uniform 404 and the signed URLs it minted are `403` (`getByTokenRaw` / `getServeableShare` in `utils/db/shares.ts`).
- **Audited routes**: `CREATE share`, `UPDATE share` (with `passwordChanged: boolean` in its metadata — the password itself is never logged), `DELETE share`, and `CREATE shareAccess` (one per successful download, with `unlocked: boolean`). The daily share sweep's hard deletes are audited too: one `DELETE shareSweep` entry per bucket in each batch, by the system user, listing the shares' ids and kinds; so are the expiries it fills in, one `UPDATE shareExpiryBackfill` entry per bucket listing each share's new `expiresAt`. A failed unlock is audited as `CREATE shareUnlockFailure` by the system user (with the address and user agent, never the password), but not every one: only the wrong password that uses up its address's `(token, ip)` window (`reason: "unlock_attempts_exhausted"`) and one verified during the share's backoff delay (`"invalid_password_during_backoff"`, an address's first, so each costs a guesser a fresh address). A typo leaves no entry, and guesses don't turn into audit rows one for one. Access-log rows: `DOWNLOAD_SHARE` for a download and `UNLOCK_SHARE` for an unlock, each with the share's bucket and (for an object share) object.
- **CHECK constraint** enforces kind/target invariants at the DB level (OBJECT requires objectId + no archive; ARCHIVE requires archiveRequestId + no object/version).

## Encryption

Envelope encryption, per-blob DEK wrapped by a master key. AES-256-GCM throughout.

- Master keys: `FILE_SERVICE_MASTER_KEY_V1`, `..._V2`, … (32-byte base64).
- `FILE_SERVICE_ACTIVE_MASTER_KEY_VERSION` selects which key wraps new DEKs.
- Blobs stay readable under their original `masterKeyVersion`; rotation is non-destructive for already-written blobs.
- **AAD-bound DEK wrap.** `wrapDek(dek, version, aad)` always sets AAD; for content blobs AAD = `Buffer.from(hash, "hex")`, for staging DEKs AAD = `uploadId`. This prevents an insider from swapping wrapped key material between rows.
- **On-disk format.** Blobs are written with a 5-byte magic header `VFBE\x01` followed by ciphertext + 16-byte tag. Multipart parts are written as `iv(12) || ciphertext || tag(16)` (no magic — internal scratch).
- **Master-key rotation.** Roll every process onto the new `FILE_SERVICE_ACTIVE_MASTER_KEY_VERSION` first (a process still on the old version keeps wrapping new DEKs under the old key), then run `npm run cli -- rewrap-master-key` (idempotent; logs its cursor after each page, so `--from-hash` / `--from-upload` resume it). A row whose DEK can't be unwrapped is logged, counted as `failed` and left; the CLI then exits non-zero. Run it again with `--dry-run` until it reports nothing to rewrap and nothing failed; only then can the old key go: drop `FILE_SERVICE_MASTER_KEY_V{old}` from env, or, for a key core generated, delete its `core.secrets` row (`DELETE FROM "core"."secrets" WHERE "name" = 'FILE_SERVICE_MASTER_KEY_V{old}'`). Rewrapping changes no DEK and no ciphertext, so it does not undo an exposure of the old master key together with the database.
- Future KMS integration: replace `wrapDek`/`unwrapDek` in `utils/encryption.ts` — the on-disk file format does not change.

## Lifecycle / TTL

Per-bucket policy stored in `BucketLifecyclePolicy`:
- `expireObjectsAfterDays` — soft-delete objects last written more than N days ago. Age counts from
  the current version's `createdAt` (the last upload, restore or branching PATCH), as S3 counts it —
  not from when the key was first created, so an object overwritten yesterday is kept.
- `expireVersionsAfterDays` — hard-delete versions non-current for more than N days. As S3's
  `NoncurrentDays`, age counts from when a newer version replaced the version (`noncurrentSince`, set
  by an overwrite, delete marker, restore or branching PATCH), not from its own upload: a year-old
  file overwritten today keeps its old version for N more days.
- `purgeSoftDeletedAfterDays` — hard-delete soft-deleted object rows (`0`: at the next sweep)
- Per-object `deleteAfter` timestamp overrides policy. Setting it (`PATCH /objects/by-id/:id`) takes delete access — the `canDelete` grant and `file-service.objects.delete` — since the sweep deletes the object later; clearing it (`null`) takes only write.

Daily `lifecycle-sweep` worker runs via BullMQ. Each sweep reads a batch, then deletes it in one
transaction, re-checking each object under its lock that it still qualifies
(`removeExpiredObjects`, `purgeSoftDeletedObjects`): an object renamed, undeleted, written again,
re-created under its key or given a later expiry since the read is left alone, and one another writer
holds is skipped until the next sweep. Each batch's audit entry (`lifecycleSweep`, by the system user,
listing what it deleted) is written in that transaction, so a crash can't lose it. Bulk delete and the
history purge do the same per batch of 100 (`objects_bulk`, `object_versions_purge`), each batch with
its webhook event in the same transaction.

## Webhook Events

Emitted with `emitTx` on mutations. Event types are declared in `src/definitions/eventTypes.ts`; payloads are in the OpenAPI spec's `webhooks:` section (`openapi/paths/files/webhook-events.yaml`). A bucket's events are emitted under its organization; a bucket outside any organization (one an app service declares) emits them with `organizationId: null` and its service's id (`bucketEventScope` in `utils/outbox.ts`), and they go only to endpoints of all organizations and to endpoints the bucket's service owns, each still subject to its creator's access to the bucket. Share events (`file-service.share.*`) are still emitted only for buckets that belong to an organization.

- `file-service.bucket.created/updated/deleted` — `updated` only when an update changed something (an unchanged `PUT` writes no audit entry or event), diffed against the bucket as read under its row lock; also when the registry retires a declared bucket (`data.retired: true`)
- `file-service.bucket.owner-changed` — `PUT /buckets/:name/owner` changed the owner (`data.ownerId`, `data.previousOwnerId`)
- `file-service.object.created/updated/deleted` — `created`/`updated` fire for every content write (authenticated upload, presigned upload, multipart complete; `data.via` says which), and `updated` also for a rename or metadata PATCH that changes something (one whose values are already the object's writes no audit entry and emits nothing) and for every version restore (`via: "restore"`, `undeleted` true when it brought back a deleted object)
- `file-service.objects.bulk-deleted` — one event per committed batch of up to 100 objects of a bulk-delete request (by prefix or by id list), rather than N per-object events; `data.batchIndex` counts the request's batches from 0
- `file-service.object.version.created/restored/deleted` — `created` fires in a versioned bucket for each new version a write makes (alongside `object.created/updated`) and for a PATCH with `createNewVersion`; restores fire `restored` instead
- `file-service.objects.versions.purged` — one per committed batch of up to 100 versions of an on-demand purge of non-current versions across a bucket, with `data.batchIndex` as above
- `file-service.permission.granted/revoked`
- `file-service.lifecycle.policy.updated/deleted` — a bucket's lifecycle policy created or replaced, or removed
- `file-service.lifecycle.policy.applied` — the `lifecycle-sweep` worker applied a policy (soft-deletes, version purge or hard-delete)
- `file-service.multipart.initiated/completed/aborted` — the upload's audit entries are `CREATE` at initiation and `UPDATE` (`metadata.completed: true`) at completion; `aborted` carries
 `reason: "aborted"` for the DELETE and `reason: "expired"` when the `multipart-sweep` worker expires an upload
- `file-service.share.created/updated/revoked`
- `file-service.share.accessed` — one per download, gated by `FILE_SERVICE_EMIT_SHARE_ACCESS_EVENTS` (default off — noisy)

## Database Schema

| Model | Purpose |
|-------|---------|
| `Bucket` | Container (policy, quota, versioningEnabled, autoThumbnails, corsConfig, rateLimitConfig) |
| `ContentBlob` | Physical blob (hash PK, sizeBytes, fsPath, refCount, wrappedDek, iv, masterKeyVersion, orphanedAt) |
| `Object` | Identity row (id UUID PK, key, deleteAfter, thumbnailFor, thumbnailSize) |
| `ObjectVersion` | Content row (id UUID PK — exposed as `versionId` on the wire, contentBlobHash, etag, contentType, metadata, tags, isCurrent, isDeleteMarker) |
| `MultipartUpload` / `MultipartPart` | In-flight staged multipart uploads |
| `ArchiveRequest` | Snapshot of a folder/multi-select archive download (expiring); its object versions are `ArchiveRequestObject` rows |
| `Share` | DB-backed revocable download link (kind OBJECT|ARCHIVE), optional password/TTL/cap |
| `BucketLifecyclePolicy` | Per-bucket retention rules |
| `BucketPermission` | Per-user per-bucket grants |
| `AccessLog` | Per-request access audit, kept `ACCESS_LOG_RETENTION_DAYS` (default 90) by a daily sweep. A 401 or 429 refused before any controller (a missing or bad token, a rate limit) writes none; signed URLs and share links log theirs |
| `IdempotencyRecord` | 24h replay cache for upload idempotency keys (scope + key unique, expiresAt indexed) |

Tables live in the `files` schema. Bucket/Object use soft deletion; BucketPermission uses `revokedAt`. A bucket name is unique among live buckets only (the partial index `buckets_live_name_key`), so deleting a bucket frees its name for a new one, which shares nothing with it: objects, grants and shares belong to the bucket's id.

## Environment Variables

The files-specific ones, from `src/env.ts`; core's shared settings (`DATABASE_URL`, `REDIS_URL`,
`PUBLIC_URL`, `CORS_ALLOWED_ORIGINS`, …) are there too.

| Variable | Description |
|----------|-------------|
| `FILE_SERVICE_STORAGE_PATH` / `_TEMP_PATH` | On-disk paths (default `./storage`, `./storage/temp`). Uploads are spooled unencrypted in `_TEMP_PATH` while processed: put it on an encrypted volume or a tmpfs |
| `FILE_SERVICE_MAX_UPLOAD_SIZE_MB` | Single-request upload ceiling (default 100) |
| `FILE_SERVICE_VERIFIED_READ_BUDGET_MB` | Plaintext that downloads verified in memory (blobs up to 16 MiB) may hold at once (default 256); a download waits up to `FILE_SERVICE_VERIFIED_READ_WAIT_SECONDS` (default 30) for room, then `503` |
| `FILE_SERVICE_MASTER_KEY_V1` | Envelope encryption master key (base64, 32 bytes). Generated into `core.secrets` when unset |
| `FILE_SERVICE_MASTER_KEY_V2`, `_V3`, … | Rotated master keys |
| `FILE_SERVICE_ACTIVE_MASTER_KEY_VERSION` | Which master key version wraps new DEKs (default 1) |
| `FILE_SERVICE_SIGNING_KEY_V1` | HMAC key for presigned and share URLs (base64, 32 bytes). Generated into `core.secrets` when unset |
| `FILE_SERVICE_SIGNING_KEY_V2` | Rotated signing key |
| `FILE_SERVICE_ACTIVE_SIGNING_KEY_VERSION` | Which signing key signs new URLs (default 1) |
| `FILE_SERVICE_PUBLIC_BASE_URL` | Base of presigned and share URLs (default `${PUBLIC_URL}/v1/files`; must be a real public URL in production) |
| `FILE_SERVICE_PRESIGN_CLOCK_SKEW_SECONDS` | Clock-skew tolerance for presigned URLs (default 30) |
| `FILE_SERVICE_MULTIPART_UPLOAD_TTL_HOURS` | Default 24 |
| `FILE_SERVICE_ORPHAN_BLOB_GRACE_SECONDS` | Delay before orphan blobs are swept (default 300) |
| `FILE_SERVICE_MIN_PART_SIZE_MB` | Multipart minimum part size (default 5) |
| `FILE_SERVICE_MAX_MULTIPART_PARTS` | Default 10000 |
| `FILE_SERVICE_MAX_ACTIVE_MULTIPART_UPLOADS` | Default 100 — multipart uploads one user may have in progress in a bucket |
| `FILE_SERVICE_MAX_PRESIGN_TTL_SECONDS` | Default 7 days |
| `FILE_SERVICE_MAX_ARCHIVE_OBJECTS` | Default 10000 — cap on objects in a single archive request |
| `FILE_SERVICE_MAX_ARCHIVE_TOTAL_BYTES` | Default 50 GiB — cap on archive plaintext size |
| `FILE_SERVICE_MAX_SHARE_TTL_SECONDS` | Hard cap on share `expiresAt` (default 365d), and the expiry a share gets without one — on create, on `PATCH { "expiresAt": null }` (from now), and for shares from before expiries were required (from creation, set by the daily share sweep) |
| `FILE_SERVICE_SHARE_SIGNED_URL_TTL_SECONDS` | TTL of the presigned URL minted per share download (default 60s) |
| `FILE_SERVICE_SHARE_UNLOCK_MAX_ATTEMPTS` | Password unlock attempts per window (default 5) |
| `FILE_SERVICE_SHARE_UNLOCK_WINDOW_SECONDS` | Password-attempt window (default 900 = 15 min) |
| `FILE_SERVICE_SHARE_DEFAULT_TOKEN_BYTES` | Random-token length in bytes (default 18 → 24 base64url chars) |
| `FILE_SERVICE_EMIT_SHARE_ACCESS_EVENTS` | Emit `file-service.share.accessed` per download (default false; noisy) |
| `FILE_SERVICE_SHARE_UI_BASE_URL` | Where browsers opening a password-protected share are redirected for the unlock page (`{ui}/shared/:token`). Defaults to `UI_BASE_URL` |
| `FILE_SERVICE_SHARE_RETENTION_DAYS` | Days between a share becoming unserveable and the share sweep deleting it, and between an archive request expiring and the archive sweep deleting it (default 30) |
| `ACCESS_LOG_RETENTION_DAYS` | Days an access-log row is kept before the daily sweep deletes it (default 90) |
| `FILE_SERVICE_SWEEP_TIME_BOX_SECONDS` / `_HEARTBEAT_SECONDS` | Sweep job time box and heartbeat (default 60 / 5) |
| `FILE_SERVICE_DISK_RECONCILIATION_MAX_FILES_PER_SHARD` | Default 10000 — files one weekly run checks per top-level shard; a run stops at it and the next resumes there (cursor in Redis), starting the shard over once it is finished |

## Commands

From `packages/tereo`:

```bash
npm run dev                # Core with hot reload, port 4001
npm run db:migrate         # Create a migration from schema.prisma (doesn't apply it)
npm run db:migrate:deploy  # Apply migrations
npm run db:seed            # Seed (idempotent)
npm run cli -- rewrap-master-key   # Re-wrap DEKs after a master-key rotation
npm test                   # Tests in Docker (npm run test:local for local vitest)
```
