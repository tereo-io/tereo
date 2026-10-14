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

// Empty: the cache prefix and TTLs are fixed so every replica of a service
// shares one `file-sdk:` namespace in Redis.
export type FileServiceClientConfig = Record<string, never>;

export type FileServiceBucketName = string;
