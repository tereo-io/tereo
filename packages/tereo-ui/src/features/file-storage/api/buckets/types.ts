import type { OrgRef, ServiceRef, UserRef } from "@/lib/refs";

export interface CorsConfig {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposedHeaders?: string[];
  maxAgeSeconds: number;
  allowCredentials: boolean;
}

export interface RateLimitConfig {
  tokensPerSecond: number;
  maxTokens: number;
  requestCost: number;
}

export interface Bucket {
  id: number;
  name: string;
  description: string | null;
  policy: "public" | "private";
  /** Omitted when the bucket has no quota. */
  storageQuotaBytes?: string | null;
  /**
   * Total on-disk bytes, including historical versions retained in a
   * versioning-enabled bucket. Quota enforcement uses this figure.
   */
  currentUsageBytes: string;
  /**
   * Sum of blob sizes across live *current* (non-delete-marker) versions.
   * Returned only on `GET /buckets/:name` for versioning-enabled buckets —
   * undefined on list endpoints and on versioning-off buckets (where
   * `currentUsageBytes` is already the live figure).
   */
  liveUsageBytes?: string;
  versioningEnabled: boolean;
  autoThumbnails: boolean;
  corsConfig: CorsConfig | null;
  rateLimitConfig: RateLimitConfig | null;
  createdAt: string;
  updatedAt: string;
  /** User id of the creator — a service-account user for declared buckets. */
  createdBy: string;
  creator: UserRef;
  /** Set when a service declared the bucket in its provisioning document. */
  serviceId: string | null;
  organizationId: string | null;
  /** Null for a bucket in no organization. */
  organization: OrgRef | null;
  serviceName: string | null;
  service: ServiceRef | null;
  /** Set when the declaring service stopped declaring it; retires a day later. */
  missingSince: string | null;
  /** Set once the declaring service stops declaring it: read-only. */
  retiredAt: string | null;
}

export interface CreateBucketInput {
  name: string;
  description?: string;
  policy?: "public" | "private";
  storageQuotaBytes?: string | null;
}

export interface UpdateBucketInput {
  description?: string;
  policy?: "public" | "private";
  storageQuotaBytes?: string;
  versioningEnabled?: boolean;
  autoThumbnails?: boolean;
  corsConfig?: CorsConfig | null;
  rateLimitConfig?: RateLimitConfig | null;
}

export interface BucketPermissions {
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
}

export interface LifecyclePolicy {
  expireObjectsAfterDays: number | null;
  expireVersionsAfterDays: number | null;
  purgeSoftDeletedAfterDays: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertLifecyclePolicyInput {
  expireObjectsAfterDays?: number | null;
  expireVersionsAfterDays?: number | null;
  purgeSoftDeletedAfterDays?: number | null;
  enabled?: boolean;
}
