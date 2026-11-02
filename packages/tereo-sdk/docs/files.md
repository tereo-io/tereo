# Files — @tereo-io/sdk

`core.files` is a `FileServiceClient` (`src/clients/files.ts`) over core's `/v1/files/buckets/…`. Types
are SDK-level in `src/types/files.ts` and re-exported from the transport types in
`src/requests/files/*/types.ts`; all are exported from the package root.

Buckets a service owns are declared in its [provisioning document](provisioning.md) (`<namespace>-…`); the
service needs the `file_user` role, and whatever bucket permissions an admin grants it.

## Addressing

Reads take the object **key**; mutations take the object's stable UUID **`id`**, which survives
renames. Holding only a key, call `resolveKey(bucket, key)` to get the object (and its `id`), or
`null`.

Listings are cursor-paged: `{ data, hasMore, limit, nextCursor }`; pass `nextCursor` back as
`cursor`.

## Objects

| Method | Returns | |
|--------|---------|---|
| `uploadObject(bucket, key, input)` | `FileServiceObject` | `input`: `{ file: Buffer \| Readable, contentType?, metadata?, tags?, ifMatch?, ifNoneMatch?, idempotencyKey? }`. Core requires an `Idempotency-Key`; the SDK generates one when omitted — pass a deterministic one (e.g. `invoice:{number}:pdf`) for retries across processes. `metadata` travels in `X-Metadata` as JSON with non-ASCII characters `\u`-escaped; `tags` in `X-Tags` as a JSON array, likewise escaped, so a tag may hold any character, commas included (needs a core that reads that form); each is trimmed, and tags over core's 50 × 128-character limits throw `InvalidRequestInputError` |
| `downloadObject(bucket, key)` | `Buffer` | |
| `getObjectMetadata(bucket, key)` | response headers | HEAD; cached 1 h |
| `getObject(bucket, id)` | `FileServiceObject \| null` | null on 404 |
| `resolveKey(bucket, key)` | `FileServiceObject \| null` | |
| `listObjects(bucket, options?)` | paged `FileServiceObject` | `limit`, `cursor`, `sort` (`objectKey`, `createdAt`, `sizeBytes`), `sortDir`, `objectKey:contains`/`startsWith`/`equals`, `contentType:contains`/`equals` — one operator per field (two throw) |
| `listObjectPrefixes(bucket, options?)` | `ListPrefixesResponse` | Folder-style listing: `prefix`, `delimiter`, `limit`, `cursor` |
| `patchObject(bucket, id, input)` | `FileServiceObject` | `objectKey` (rename), `contentType`, `metadata`, `tags`, `deleteAfter` (`null` clears), `createNewVersion` |
| `deleteObject(bucket, id)` | `void` | Soft delete. A 404 resolves (already gone); every other failure throws |
| `bulkDeleteObjects(bucket, { prefix } \| { ids })` | `{ deletedCount, truncated }` | Throws on failure. Caps: 10,000 per prefix, 1,000 ids — re-invoke while `truncated` |
| `purgeNonCurrentVersions(bucket)` | `{ purgedCount, bytesFreed, truncated }` | Capped at 10,000 per call |

## Versions, presigned URLs, archives

| Method | Returns | |
|--------|---------|---|
| `listObjectVersions(bucket, id, options?)` | `ListObjectVersionsResponse` | |
| `getObjectVersion(bucket, id, versionId)` | `ObjectVersion` | |
| `downloadObjectVersion(bucket, id, versionId)` | `Buffer` | |
| `restoreObjectVersion(bucket, id, versionId)` | `RestoreObjectVersionResponse` | Makes the version current. Restoring a version of a deleted object undeletes it (409 if another live object has taken its key); `getObject` answers null for a deleted object, but its versions stay reachable by id in a versioned bucket |
| `deleteObjectVersion(bucket, id, versionId)` | `void` | |
| `presignObjectUrl(bucket, id, input?)` | `{ url, expiresAt, operation }` | `input`: `{ operation?: "read" \| "write", expiresInSeconds? }`. The URL names the object by id (`/v1/files/signed/objects/:bucket/by-id/:id`), so it survives a rename |
| `createArchive(bucket, input)` | `{ id, url, expiresAt, objectCount, totalSizeBytes, format, filename }` | `input`: `prefix` or `keys`, `format` (`zip`, `tar`), `expiresInSeconds`, `filename`. A prefix archive's entries drop the prefix. The URL is the only way to download it |

## Shares

Public links to an object (or one version) or an archive, optionally with a password, expiry and
download limit.

| Method | Returns | |
|--------|---------|---|
| `createShare(bucket, input)` | `Share` | `{ kind: "OBJECT", objectId, versionId? }` or `{ kind: "ARCHIVE", prefix?, keys?, format?, archiveFilename? }`, plus `password?`, `expiresAt?`, `maxDownloads?`, `urlFilename?`, `note?` |
| `listShares(bucket, options?)` | `ListSharesResponse` | |
| `getShare(bucket, id)` | `Share` | |
| `updateShare(bucket, id, input)` | `Share` | |
| `revokeShare(bucket, id)` | `void` | |

## Buckets and permissions

| Method | Returns | |
|--------|---------|---|
| `listBuckets(options?)` | `ListBucketsResponse` | |
| `getBucket(name)` | `Bucket \| null` | Cached 1 h; null on 404. Without `file-service.admin`, core answers a missing bucket with 403 like an inaccessible one, which throws |
| `createBucket(input)` / `updateBucket(name, input)` / `deleteBucket(name)` | `Bucket` / `Bucket` / `void` | Update and delete drop the cached bucket |
| `invalidateBucket(name)` | `void` | Drops the cached bucket |
| `getMyBucketPermissions(name)` | `{ canRead, canWrite, canDelete }` | |
| `listBucketPermissions(bucket, options?)` | `ListBucketPermissionsResponse` | |
| `grantBucketPermission(bucket, input)` / `revokeBucketPermission(bucket, userId)` | `BucketPermission` / `void` | Flags default to `false`. A grant to a user outside the bucket's organization is a 400 `user_not_in_organization`; an unknown user 404; an existing grant 409. Revoking a declaring service's own grant is a 409 `bucket_declared` |
| `getBucketLifecyclePolicy(bucket)` | `LifecyclePolicy` | `expireObjectsAfterDays`, `expireVersionsAfterDays`, `purgeSoftDeletedAfterDays`, `enabled`. Core answers 404 (which throws) when the bucket has none |
| `upsertBucketLifecyclePolicy(bucket, input)` / `deleteBucketLifecyclePolicy(bucket)` | `LifecyclePolicy` / `void` | Upsert replaces the whole policy: a rule left out becomes `null`, `enabled` left out `true` |

## Multipart uploads

`initiateMultipart(bucket, key, input)` → `uploadPart(bucket, uploadId, partNumber, input)` per part →
`completeMultipart(bucket, uploadId, input)`; `listMultipartParts(bucket, uploadId)` and
`abortMultipart(bucket, uploadId)` along the way. Parts are sent as `application/octet-stream`; the
object's type is the `contentType` given to `initiateMultipart`. `initiateMultipart` and
`completeMultipart` accept `ifMatch` and `ifNoneMatch`. Driving them by hand, a `412` at complete
leaves the upload open: abort it, or retry the complete, or it stays until it expires.

### Automatic multipart in `uploadObject`

`uploadObject` takes a `Buffer` or a `Readable`. Up to `multipartThresholdBytes` it sends one `PUT`;
above that it initiates a multipart upload, sends parts with up to `partConcurrency` in flight, and
completes. Set the options under `createCoreClient({ files: { … } })`:

| Option | Default | |
|--------|---------|---|
| `multipartThresholdBytes` | 64 MiB | Largest upload sent as one `PUT`. Keep it under core's `FILE_SERVICE_MAX_UPLOAD_SIZE_MB` (100 MB by default), or uploads between the two fail |
| `partSizeBytes` | 16 MiB | At least core's `FILE_SERVICE_MIN_PART_SIZE_MB` (5 by default); the client throws below 5 MiB |
| `partConcurrency` | 4 | Parts in flight; an integer of at least 1 |

`createCoreClient` throws on a part size under 5 MiB, a threshold below the part size, or a concurrency
that is not an integer of at least 1.

- `ifMatch` and `ifNoneMatch` apply on both paths. Multipart checks them at initiate (advisory) and at
  complete (authoritative). `uploadObject` aborts the upload on a `412` at complete, like any failure
  after initiate.
- Memory for a stream: the head read (up to the threshold plus 1 byte) plus up to `partConcurrency`
  parts while the head is consumed, then about `partSizeBytes × (partConcurrency + 1)`. A `Buffer`
  is already in memory.
- On any failure after initiate, the upload is aborted best-effort and the original error is rethrown.
  A failed multipart destroys the caller's stream.
- There is no read timeout. A caller whose source may stall should time it out itself.

## Cache

| Data | Key | TTL |
|------|-----|-----|
| Bucket | `@tereo-io/sdk:<clientId>:file-sdk:v1:bucket:{name}` | 1 h |
| Object metadata (`getObjectMetadata`) | `@tereo-io/sdk:<clientId>:file-sdk:v1:object:{bucket}/{key}` | 1 h |

In the Redis passed to `createCoreClient`, shared by the service's replicas and by no other service.
Object bytes are never cached. `core.start()` also subscribes (on a duplicate connection) to core's
invalidation channels, `file-service:bucket-invalidate` and `file-service:object-invalidate`, so a
change made anywhere drops the entry — when that Redis is the one core publishes on. A core with
`REDIS_KEY_PREFIX` set publishes them under that prefix; pass the same value as `channelPrefix` to
`createCoreClient`. On a Redis of
its own, a change made elsewhere shows after the TTL; `uploadObject` and `patchObject` also drop the entry for their resulting key at
once. A Redis failure falls through to core.

With `createCoreClient({ testMode: true })` every method returns stubs — see [testing](testing.md).
