export type {
  Bucket,
  BucketPermission,
  CreateBucketInput,
  FileServiceCorsConfig as CorsConfig,
  FileServiceObject,
  FileServiceObjectMetadata,
  FileServiceRateLimitConfig as RateLimitConfig,
  GrantBucketPermissionInput,
  ListBucketPermissionsOptions,
  ListBucketPermissionsResponse,
  ListBucketsOptions,
  ListBucketsResponse,
  ListObjectsOptions,
  ListObjectsResponse,
  MyBucketPermissions,
  UpdateBucketInput,
  UploadObjectInput,
} from "../handler.js";

// The cache prefix and TTLs are fixed so every replica of a service shares one
// `file-sdk:` namespace in Redis.
export interface FileServiceClientConfig {
  /** Uploads larger than this go up as multipart. Default 64 MiB; at least `partSizeBytes`. */
  multipartThresholdBytes?: number;
  /** Size of each multipart part. Default 16 MiB; at least 5 MiB. */
  partSizeBytes?: number;
  /** Parts in flight at once, an integer of at least 1. Default 4. */
  partConcurrency?: number;
}

export type FileServiceBucketName = string;
