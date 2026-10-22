import type { OrgRef, ServiceRef, UserRef } from "../../refs.js";

/**
 * Bucket access policy.
 *
 * - `public`: Anonymous reads allowed on objects; writes still require auth + bucket-level permission.
 * - `private`: All reads require auth + bucket-level `canRead` permission.
 */
export type BucketPolicy = "public" | "private";

/**
 * Per-bucket CORS configuration. When set on a bucket, its values override
 * the service-wide default for object-level requests against that bucket.
 */
export interface CorsConfig {
  allowedOrigins: string[];
  allowedMethods: ("GET" | "HEAD" | "PUT" | "POST" | "DELETE" | "PATCH")[];
  allowedHeaders: string[];
  exposedHeaders?: string[];
  maxAgeSeconds: number;
  allowCredentials: boolean;
}

/**
 * Per-bucket token-bucket rate limit configuration. When set, applies on top
 * of the service-wide rate limit for object-level requests against the bucket.
 */
export interface RateLimitConfig {
  tokensPerSecond: number;
  maxTokens: number;
  requestCost: number;
}

/**
 * A storage bucket.
 *
 * `storageQuotaBytes` and `currentUsageBytes` are serialized as strings because
 * they are PostgreSQL `BIGINT` columns. `storageQuotaBytes` is absent when
 * the bucket has no quota (unlimited).
 */
export interface Bucket {
  /** Internal numeric bucket id. */
  id: number;
  /** Unique bucket name (3-63 chars, lowercase alphanumeric + hyphens). */
  name: string;
  /** Optional human-readable description (max 500 chars). `null` when unset. */
  description: string | null;
  /** Access policy controlling anonymous read access to objects. */
  policy: BucketPolicy;
  /** Max storage quota in bytes (BigInt as string). Absent when unlimited. */
  storageQuotaBytes?: string;
  /** Current storage consumption in bytes (BigInt as string). */
  currentUsageBytes: string;
  /**
   * Bytes held by live current versions. Only on a single-bucket read of a
   * versioning-enabled bucket.
   */
  liveUsageBytes?: string;
  /** Whether new uploads create versioned ObjectVersion rows. */
  versioningEnabled: boolean;
  /** Whether image uploads automatically generate a thumbnail. */
  autoThumbnails: boolean;
  /** Per-bucket CORS override. `null` when using the service-wide default. */
  corsConfig: CorsConfig | null;
  /** Per-bucket rate-limit override. `null` when using the service-wide default. */
  rateLimitConfig: RateLimitConfig | null;
  /** User id of the creator; a declared bucket's is its service's account. */
  createdBy: string;
  /** The user `createdBy` names. */
  creator: UserRef;
  /**
   * The user who manages the bucket, while they hold an active grant on it.
   * Starts as `createdBy`; changes only by a `file-service.admin` transfer.
   */
  ownerId: string;
  /** The user `ownerId` names. */
  owner: UserRef;
  /** The service that declared the bucket; `null` for an admin-created one. */
  serviceId: string | null;
  organizationId: string | null;
  /** The organization `organizationId` names; `null` when it is null. */
  organization: OrgRef | null;
  serviceName: string | null;
  /** The service `serviceId` names; `null` when it is null. */
  service: ServiceRef | null;
  /** Set while a declared bucket is missing from its service's declaration. */
  missingSince: string | null;
  /** Set once a declared bucket is retired; it is then read-only. */
  retiredAt: string | null;
  /** ISO timestamp of bucket creation. */
  createdAt: string;
  /** ISO timestamp of last bucket update. */
  updatedAt: string;
}

export interface ListBucketsOptions {
  limit?: number;
  cursor?: string;
  sort?: "name" | "description" | "policy" | "currentUsageBytes" | "createdAt";
  sortDir?: "asc" | "desc";
}

export interface ListBucketsResponse {
  data: Bucket[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

export interface CreateBucketInput {
  /** Bucket name (3-63 chars, lowercase alphanumeric + hyphens). */
  name: string;
  /** Optional description (max 500 chars). */
  description?: string;
  /** Access policy. Defaults to `private` server-side. */
  policy?: BucketPolicy;
  /**
   * Storage quota in bytes (max 1 TB). Accepts number, string (BigInt-safe),
   * or `null` for unlimited. Omit to leave unset.
   */
  storageQuotaBytes?: number | string | null;
}

export interface UpdateBucketInput {
  description?: string;
  policy?: BucketPolicy;
  /** Storage quota in bytes (max 1 TB), BigInt-safe as a string; `null` clears it. */
  storageQuotaBytes?: number | string | null;
  versioningEnabled?: boolean;
  autoThumbnails?: boolean;
  /** Pass `null` to clear any existing per-bucket CORS override. */
  corsConfig?: CorsConfig | null;
  /** Pass `null` to clear any existing per-bucket rate-limit override. */
  rateLimitConfig?: RateLimitConfig | null;
}

/**
 * Effective permissions for the calling user on a bucket, as returned by
 * `GET /buckets/:name/my-permissions`. `admin` principals see every flag
 * `true`; anyone else their own grant's flags, plus `canRead` on a public
 * bucket. A missing bucket, another organization's, or a private one the
 * caller holds no grant on is the same 403, so it can't confirm a name exists.
 */
export interface MyBucketPermissions {
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
}
