/**
 * Custom object metadata.
 *
 * Core accepts JSON objects up to 100KB and 100 keys. Values may be
 * strings, numbers, booleans, null, or nested arrays of the same.
 */
export type FileServiceObjectMetadata = Record<string, unknown>;

/**
 * An object (file) stored in a bucket.
 *
 * Returned by list/upload endpoints. Note that `sizeBytes` is a string because
 * the underlying column is a PostgreSQL `BIGINT` serialized via `.toString()`.
 * `metadata` may be omitted on update responses, `null` when no metadata was
 * supplied on upload, or a JSON object for new uploads.
 */
export interface FileServiceObject {
  /**
   * Stable UUID for the object. This is the identifier used in every
   * mutating endpoint (`DELETE /by-id/:id`, `PATCH /by-id/:id`, etc.).
   * Reads (download, HEAD) still address objects by `key`.
   */
  id: string;
  /** Object key (path within the bucket). Maps to the `object_key` column. */
  key: string;
  /** Detected or supplied MIME type. */
  contentType: string;
  /** File size in bytes, serialized as a string (BigInt). */
  sizeBytes: string;
  /** Entity tag for cache validation (SHA-256 based). */
  etag: string;
  /** Custom metadata supplied at upload time. `null` if unset, absent on update responses. */
  metadata?: FileServiceObjectMetadata | null;
  /** User-supplied tags. Always present — empty array when none. */
  tags: string[];
  /**
   * Per-object TTL override (ISO timestamp) or `null` when no override is set.
   * When set, the object is soft-deleted after this time regardless of bucket
   * lifecycle policy.
   */
  deleteAfter?: string | null;
  /** ISO timestamp of object creation. */
  createdAt: string;
  /** ISO timestamp of last update. Absent from create (201) responses. */
  updatedAt?: string;
}

export interface ListObjectsOptions {
  limit?: number;
  /** Opaque cursor from a prior response's `nextCursor`. Omit on first call. */
  cursor?: string;
  sort?: "objectKey" | "createdAt" | "sizeBytes";
  sortDir?: "asc" | "desc";
  "objectKey:contains"?: string;
  "objectKey:startsWith"?: string;
  "objectKey:equals"?: string;
  "contentType:contains"?: string;
  "contentType:equals"?: string;
}

export interface ListObjectsResponse {
  data: FileServiceObject[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

/** Body shape for `PATCH /buckets/:name/objects/by-id/:id`. */
export interface PatchObjectInput {
  /** New object key (rename). Partial-unique live-key index enforces uniqueness. */
  objectKey?: string;
  contentType?: string;
  metadata?: FileServiceObjectMetadata;
  tags?: string[];
  /**
   * Per-object TTL override. ISO string sets it, `null` clears the override
   * (object then follows the bucket-level lifecycle policy), `undefined`
   * leaves the current value alone.
   */
  deleteAfter?: string | null;
  /**
   * Versioning-enabled buckets only: when true, branches a new version row
   * instead of editing the current one in place. Ignored elsewhere.
   */
  createNewVersion?: boolean;
}

/**
 * Body shape for `POST /buckets/:name/objects/bulk-delete`. Supply exactly
 * one of `prefix` or `ids`.
 */
export interface BulkDeleteInput {
  /** Key prefix to match (non-empty). Capped at 10,000 objects per request. */
  prefix?: string;
  /** Explicit object ids (max 1,000 per request). */
  ids?: string[];
}

export interface BulkDeleteResponse {
  deletedCount: number;
  /** True when a prefix request hit the server-side cap — caller should re-invoke. */
  truncated: boolean;
}

/**
 * Response shape for `POST /buckets/:name/objects/purge-non-current-versions`.
 * Soft-deletes every non-current, live version row in the bucket; the current
 * version of each object is left untouched.
 */
export interface PurgeNonCurrentVersionsResponse {
  purgedCount: number;
  /**
   * Sum of blob bytes refunded to the bucket's `currentUsageBytes` (string —
   * server-side bigint). Equals total released-version blob sizes, matching
   * how every retained ref contributes to the counter.
   */
  bytesFreed: string;
  /** True when the per-request cap (10,000) was reached — caller should re-invoke. */
  truncated: boolean;
}

export interface UploadObjectInput {
  file: Buffer;
  contentType?: string;
  metadata?: FileServiceObjectMetadata;
  /**
   * Optional tags to attach to the uploaded object, each trimmed. Sent as
   * the `X-Tags` header in its JSON-array form, so any character, commas
   * included, is allowed — max 50 tags, each up to 128 characters.
   */
  tags?: string[];
  /**
   * Optional `If-Match` precondition — reject the upload with 412 unless the
   * current object ETag matches. Useful for optimistic-concurrency overwrites.
   */
  ifMatch?: string;
  /**
   * Optional `If-None-Match` precondition — reject the upload with 412 if the
   * object already exists. Use the literal `"*"` for atomic-create semantics.
   */
  ifNoneMatch?: string | "*";
  /**
   * Idempotency key sent as `Idempotency-Key` header. The server requires
   * this header on every upload PUT — if omitted here, the SDK generates a
   * UUIDv7. Pass a deterministic, content-bound value (e.g.
   * `invoice:{invoiceNumber}:pdf`) when you want retries across process
   * boundaries to dedupe to the first successful upload.
   */
  idempotencyKey?: string;
}
