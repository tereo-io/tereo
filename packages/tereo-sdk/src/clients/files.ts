import { getOriginalStatus, requests } from "../handler.js";
import { FileCache } from "../utils/fileCache.js";
import type {
  Bucket,
  BucketPermission,
  CreateBucketInput,
  FileServiceClientConfig,
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
  FileServiceObject,
} from "../types/files.js";
import type {
  BulkDeleteInput,
  BulkDeleteResponse,
  CompleteMultipartInput,
  CompleteMultipartResponse,
  CreateArchiveInput,
  CreateArchiveResponse,
  CreateShareInput,
  InitiateMultipartInput,
  InitiateMultipartResponse,
  LifecyclePolicy,
  ListObjectVersionsOptions,
  ListObjectVersionsResponse,
  ListPrefixesOptions,
  ListPrefixesResponse,
  MultipartUploadInfo,
  ObjectVersion,
  PatchObjectInput,
  PresignObjectInput,
  PresignObjectResponse,
  PurgeNonCurrentVersionsResponse,
  RestoreObjectVersionResponse,
  ListSharesOptions,
  ListSharesResponse,
  Share,
  UpdateShareInput,
  UploadPartInput,
  UploadPartResponse,
  UpsertLifecyclePolicyInput,
} from "../handler.js";

/** Standardized cache TTL — shared across every consuming service. */
const METADATA_CACHE_TTL_SECONDS = 3600; // 1h — bucket metadata
const OBJECT_METADATA_CACHE_TTL_SECONDS = 3600; // 1h — per-object metadata

function objectCacheKey(bucket: string, key: string): string {
  return `object:${bucket}/${key}`;
}

/** Who test mode says wrote what it makes up. */
const TEST_USER = { id: "test", email: "test@example.com", name: "Test" };

export class FileServiceClient {
  private readonly cache: FileCache = new FileCache();

  /**
   * Cache prefix, TTL and Redis are standardized. `testMode` answers every
   * method with a stub instead of calling core; `createCoreClient` passes its
   * own `testMode`.
   */
  constructor(
    _config?: FileServiceClientConfig,
    private readonly testMode = false
  ) {}

  // ---------------------------------------------------------------------------
  // Objects (no byte caching)
  // ---------------------------------------------------------------------------

  async uploadObject(
    bucket: string,
    key: string,
    data: UploadObjectInput
  ): Promise<FileServiceObject> {
    if (this.testMode) {
      return this.makeMockObject(bucket, key, data);
    }
    const result = (await requests.files.uploadObject(
      bucket,
      key,
      data
    )) as unknown as FileServiceObject;
    // Drop any cached per-object metadata locally. The server also broadcasts
    // an invalidation for the rest of the fleet.
    await this.cache.del(objectCacheKey(bucket, key));
    return result;
  }

  async downloadObject(bucket: string, key: string): Promise<Buffer> {
    if (this.testMode) {
      return Buffer.from(`test-file-contents:${bucket}/${key}`);
    }
    return requests.files.downloadObject(bucket, key);
  }

  async getObjectMetadata(
    bucket: string,
    key: string
  ): Promise<Record<string, string>> {
    if (this.testMode) {
      return { "content-type": "application/octet-stream", etag: "test-etag" };
    }
    const cacheKey = objectCacheKey(bucket, key);
    const cached = await this.cache.get<Record<string, string>>(cacheKey);
    if (cached) return cached;
    const meta = await requests.files.getObjectMetadata(bucket, key);
    await this.cache.set(cacheKey, meta, OBJECT_METADATA_CACHE_TTL_SECONDS);
    return meta;
  }

  async listObjects(
    bucket: string,
    options?: ListObjectsOptions
  ): Promise<ListObjectsResponse> {
    if (this.testMode) {
      return { data: [], hasMore: false, limit: 50, nextCursor: null };
    }
    return requests.files.listObjects(
      bucket,
      options as Parameters<typeof requests.files.listObjects>[1]
    ) as unknown as Promise<ListObjectsResponse>;
  }

  /**
   * Soft-delete an object by its stable UUID id. A 404 counts as success
   * (the object is already gone); every other failure throws, as
   * `bulkDeleteObjects` does. Local cache invalidation happens via the
   * server's pub/sub broadcast (which includes the current objectKey).
   */
  async deleteObject(bucket: string, id: string): Promise<void> {
    if (this.testMode) return;
    try {
      await requests.files.deleteObject(bucket, id);
    } catch (error) {
      if (getOriginalStatus(error) === 404) return;
      throw error;
    }
  }

  /**
   * Bulk soft-delete objects by key prefix or by explicit id list. Failures
   * throw, so the caller can retry a partial deletion.
   *
   * Server-side caps: 10,000 objects per prefix request, 1,000 ids per id
   * request. When a prefix request hits the cap, the response sets
   * `truncated: true` and the caller should re-invoke.
   */
  async bulkDeleteObjects(
    bucket: string,
    input: BulkDeleteInput
  ): Promise<BulkDeleteResponse> {
    if (this.testMode) return { deletedCount: 0, truncated: false };
    return requests.files.bulkDeleteObjects(bucket, input);
  }

  /**
   * Purge every non-current, live version row in a bucket. Releases blob
   * refs; orphan blobs are reclaimed by the orphan-blob worker. Capped at
   * 10,000 versions per request — when `truncated: true` the caller should
   * re-invoke until it returns `false`.
   */
  async purgeNonCurrentVersions(
    bucket: string
  ): Promise<PurgeNonCurrentVersionsResponse> {
    if (this.testMode)
      return { purgedCount: 0, bytesFreed: "0", truncated: false };
    return requests.files.purgeNonCurrentVersions(bucket);
  }

  /**
   * Fetch an object's metadata by its stable UUID id. Bypasses the key-based
   * cache (since id alone doesn't identify the cache key); callers that need
   * cache hits should use `getObjectMetadata(bucket, key)` instead.
   */
  async getObject(
    bucket: string,
    id: string
  ): Promise<FileServiceObject | null> {
    if (this.testMode) {
      return {
        id,
        key: "test",
        contentType: "application/octet-stream",
        sizeBytes: "0",
        etag: "test-etag",
        metadata: null,
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    try {
      return await requests.files.getObject(bucket, id);
    } catch (error) {
      if (getOriginalStatus(error) === 404) return null;
      throw error;
    }
  }

  /**
   * Patch an object: rename (`objectKey`) and/or update current-version
   * metadata. Drops the cached metadata for the object's resulting key; on a
   * rename the previous key is unknown here, and core's invalidation broadcast
   * (old and new keys) drops it.
   */
  async patchObject(
    bucket: string,
    id: string,
    input: PatchObjectInput
  ): Promise<FileServiceObject> {
    if (this.testMode) {
      return {
        id,
        key: input.objectKey ?? "test",
        contentType: input.contentType ?? "application/octet-stream",
        sizeBytes: "0",
        etag: "test-etag",
        metadata: input.metadata ?? null,
        tags: input.tags ?? [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    const result = await requests.files.patchObject(bucket, id, input);
    await this.cache.del(objectCacheKey(bucket, result.key));
    return result;
  }

  /**
   * Resolve a (bucket, key) pair to a `FileServiceObject` so callers that
   * only hold a key can discover the stable UUID id before issuing
   * id-addressed mutations. Returns `null` when no live object exists at
   * that key.
   */
  async resolveKey(
    bucket: string,
    key: string
  ): Promise<FileServiceObject | null> {
    if (this.testMode) {
      return {
        id: "00000000-0000-4000-8000-000000000000",
        key,
        contentType: "application/octet-stream",
        sizeBytes: "0",
        etag: "test-etag",
        metadata: null,
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    return await requests.files.resolveKey(bucket, key);
  }

  // ---------------------------------------------------------------------------
  // Buckets (metadata cached 1h)
  // ---------------------------------------------------------------------------

  async listBuckets(
    options?: ListBucketsOptions
  ): Promise<ListBucketsResponse> {
    if (this.testMode) {
      return { data: [], hasMore: false, limit: 50, nextCursor: null };
    }
    return requests.files.listBuckets(
      options as Parameters<typeof requests.files.listBuckets>[0]
    ) as unknown as Promise<ListBucketsResponse>;
  }

  async getBucket(name: string): Promise<Bucket | null> {
    if (this.testMode) {
      return this.makeMockBucket(name);
    }
    const cacheKey = `bucket:${name}`;
    const cached = await this.cache.get<Bucket>(cacheKey);
    if (cached) return cached;
    try {
      const bucket = (await requests.files.getBucket(
        name
      )) as unknown as Bucket;
      await this.cache.set(cacheKey, bucket, METADATA_CACHE_TTL_SECONDS);
      return bucket;
    } catch (error) {
      if (getOriginalStatus(error) === 404) return null;
      throw error;
    }
  }

  async createBucket(input: CreateBucketInput): Promise<Bucket> {
    if (this.testMode) {
      return this.makeMockBucket(input.name);
    }
    return requests.files.createBucket(input) as unknown as Promise<Bucket>;
  }

  async updateBucket(name: string, input: UpdateBucketInput): Promise<Bucket> {
    if (this.testMode) {
      return this.makeMockBucket(name);
    }
    const bucket = (await requests.files.updateBucket(
      name,
      input as Parameters<typeof requests.files.updateBucket>[1]
    )) as unknown as Bucket;
    await this.cache.del(`bucket:${name}`);
    return bucket;
  }

  async deleteBucket(name: string): Promise<void> {
    if (this.testMode) return;
    await requests.files.deleteBucket(name);
    await this.cache.del(`bucket:${name}`);
  }

  /** `file-service.admin` only. The new owner gets a full grant if they hold none. */
  async transferBucketOwnership(name: string, userId: string): Promise<Bucket> {
    if (this.testMode) {
      return { ...this.makeMockBucket(name), ownerId: userId };
    }
    const bucket = (await requests.files.transferBucketOwnership(
      name,
      userId
    )) as unknown as Bucket;
    await this.cache.del(`bucket:${name}`);
    return bucket;
  }

  async getMyBucketPermissions(name: string): Promise<MyBucketPermissions> {
    if (this.testMode) {
      return {
        canRead: true,
        canWrite: true,
        canDelete: true,
      };
    }
    return requests.files.getMyBucketPermissions(
      name
    ) as unknown as Promise<MyBucketPermissions>;
  }

  async invalidateBucket(name: string): Promise<void> {
    if (this.testMode) return;
    await this.cache.del(`bucket:${name}`);
  }

  // ---------------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------------

  async listBucketPermissions(
    bucket: string,
    options?: ListBucketPermissionsOptions
  ): Promise<ListBucketPermissionsResponse> {
    if (this.testMode) {
      return { data: [], hasMore: false, limit: 50, nextCursor: null };
    }
    return requests.files.listBucketPermissions(
      bucket,
      options as Parameters<typeof requests.files.listBucketPermissions>[1]
    ) as unknown as Promise<ListBucketPermissionsResponse>;
  }

  async grantBucketPermission(
    bucket: string,
    input: GrantBucketPermissionInput
  ): Promise<BucketPermission> {
    if (this.testMode) {
      return {
        id: 1,
        userId: input.userId,
        canRead: input.canRead ?? false,
        canWrite: input.canWrite ?? false,
        canDelete: input.canDelete ?? false,
        grantedAt: new Date().toISOString(),
        grantedBy: TEST_USER.id,
        userEmail: null,
        userName: null,
        user: null,
        grantedByEmail: TEST_USER.email,
        grantedByName: TEST_USER.name,
        granter: TEST_USER,
      };
    }
    return requests.files.grantBucketPermission(
      bucket,
      input
    ) as unknown as Promise<BucketPermission>;
  }

  async revokeBucketPermission(bucket: string, userId: string): Promise<void> {
    if (this.testMode) return;
    await requests.files.revokeBucketPermission(bucket, userId);
  }

  // ---------------------------------------------------------------------------
  // Prefixes (tree-view)
  // ---------------------------------------------------------------------------

  async listObjectPrefixes(
    bucket: string,
    options?: ListPrefixesOptions
  ): Promise<ListPrefixesResponse> {
    if (this.testMode) {
      return {
        data: [],
        hasMore: false,
        limit: options?.limit ?? 100,
        nextCursor: null,
      };
    }
    return await requests.files.listObjectPrefixes(bucket, options);
  }

  // ---------------------------------------------------------------------------
  // Versions
  // ---------------------------------------------------------------------------

  /**
   * All version operations are addressed by the object's stable UUID `id`,
   * not `objectKey`. Local cache invalidation on mutations is handled by the
   * server's pub/sub broadcast (which includes the current objectKey).
   */
  async listObjectVersions(
    bucket: string,
    id: string,
    options?: ListObjectVersionsOptions
  ): Promise<ListObjectVersionsResponse> {
    if (this.testMode) {
      return { data: [], hasMore: false, limit: 50, nextCursor: null };
    }
    return await requests.files.listObjectVersions(bucket, id, options);
  }

  async getObjectVersion(
    bucket: string,
    id: string,
    versionId: string
  ): Promise<ObjectVersion> {
    if (this.testMode) {
      return {
        versionId,
        contentBlobHash: null,
        etag: null,
        sizeBytes: null,
        contentType: null,
        metadata: null,
        tags: [],
        isCurrent: false,
        isDeleteMarker: false,
        restoredFromVersionId: null,
        createdAt: new Date().toISOString(),
        createdBy: TEST_USER.id,
        createdByEmail: TEST_USER.email,
        createdByName: TEST_USER.name,
        creator: TEST_USER,
      };
    }
    return await requests.files.getObjectVersion(bucket, id, versionId);
  }

  async restoreObjectVersion(
    bucket: string,
    id: string,
    versionId: string
  ): Promise<RestoreObjectVersionResponse> {
    if (this.testMode) {
      return {
        versionId: "restored",
        contentBlobHash: null,
        etag: null,
        sizeBytes: null,
        contentType: null,
        createdAt: new Date().toISOString(),
      };
    }
    return await requests.files.restoreObjectVersion(bucket, id, versionId);
  }

  async deleteObjectVersion(
    bucket: string,
    id: string,
    versionId: string
  ): Promise<void> {
    if (this.testMode) return;
    await requests.files.deleteObjectVersion(bucket, id, versionId);
  }

  /**
   * Download the raw bytes of a specific version. Unlike
   * `downloadObject(bucket, key)`, this path binds to the object's stable
   * UUID id, so the URL stays valid after a rename.
   */
  async downloadObjectVersion(
    bucket: string,
    id: string,
    versionId: string
  ): Promise<Buffer> {
    if (this.testMode) {
      return Buffer.from(`test-version-bytes:${bucket}/${id}/${versionId}`);
    }
    return await requests.files.downloadObjectVersion(bucket, id, versionId);
  }

  // ---------------------------------------------------------------------------
  // Presigned URLs
  // ---------------------------------------------------------------------------

  /**
   * Generate a presigned URL for read/write access. Addressed by the
   * object's UUID id, as is the URL itself, so it survives a rename.
   */
  async presignObjectUrl(
    bucket: string,
    id: string,
    input?: PresignObjectInput
  ): Promise<PresignObjectResponse> {
    if (this.testMode) {
      return {
        url: `test-presigned-url:${bucket}/${id}`,
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        operation: input?.operation ?? "read",
      };
    }
    return await requests.files.presignObjectUrl(bucket, id, input);
  }

  // ---------------------------------------------------------------------------
  // Archives
  // ---------------------------------------------------------------------------

  /**
   * Create a server-side archive request (folder-by-prefix or explicit key
   * list) and return a presigned URL that streams the zip/tar. The archive's
   * object list is snapshotted at create time, so the returned URL is stable
   * even if the caller adds or deletes objects before the download starts.
   */
  async createArchive(
    bucket: string,
    input: CreateArchiveInput
  ): Promise<CreateArchiveResponse> {
    if (this.testMode) {
      return {
        id: "test-archive-id",
        url: `test-archive-url:${bucket}`,
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        objectCount: input.keys?.length ?? 0,
        totalSizeBytes: "0",
        format: input.format ?? "zip",
        filename: input.filename ?? `${bucket}.${input.format ?? "zip"}`,
      };
    }
    return await requests.files.createArchive(bucket, input);
  }

  // ---------------------------------------------------------------------------
  // Shares
  // ---------------------------------------------------------------------------

  /**
   * Create a revocable share link for an object (kind=OBJECT) or a server-
   * built archive (kind=ARCHIVE). The returned Share.url is the public
   * /shared/:token link; hand it directly to recipients.
   */
  async createShare(bucket: string, input: CreateShareInput): Promise<Share> {
    if (this.testMode) {
      return this.makeTestShare(bucket, input);
    }
    return await requests.files.createShare(bucket, input);
  }

  async listShares(
    bucket: string,
    options?: ListSharesOptions
  ): Promise<ListSharesResponse> {
    if (this.testMode) {
      return {
        data: [],
        hasMore: false,
        limit: options?.limit ?? 50,
        nextCursor: null,
      };
    }
    return await requests.files.listShares(bucket, options);
  }

  async getShare(bucket: string, id: string): Promise<Share> {
    if (this.testMode) {
      return this.makeTestShare(bucket, {
        kind: "OBJECT",
        objectId: "test-object-id",
      });
    }
    return await requests.files.getShare(bucket, id);
  }

  async updateShare(
    bucket: string,
    id: string,
    input: UpdateShareInput
  ): Promise<Share> {
    if (this.testMode) {
      const base = this.makeTestShare(bucket, {
        kind: "OBJECT",
        objectId: "test-object-id",
      });
      return { ...base, id, note: input.note ?? base.note };
    }
    return await requests.files.updateShare(bucket, id, input);
  }

  async revokeShare(bucket: string, id: string): Promise<void> {
    if (this.testMode) return;
    await requests.files.revokeShare(bucket, id);
  }

  private makeTestShare(bucket: string, input: CreateShareInput): Share {
    const token = "test-share-token";
    return {
      id: "test-share-id",
      token,
      bucketId: 0,
      kind: input.kind,
      url: `test-share-url:${bucket}/${token}`,
      urlFilename: input.urlFilename ?? null,
      objectId: input.kind === "OBJECT" ? input.objectId : null,
      versionId: input.kind === "OBJECT" ? (input.versionId ?? null) : null,
      archiveRequestId: input.kind === "ARCHIVE" ? "test-archive-id" : null,
      hasPassword: Boolean(input.password),
      expiresAt:
        input.expiresAt instanceof Date
          ? input.expiresAt.toISOString()
          : (input.expiresAt ?? null),
      maxDownloads: input.maxDownloads ?? null,
      downloadCount: 0,
      revokedAt: null,
      revokedByUserId: null,
      revokedByUser: null,
      note: input.note ?? null,
      createdByUserId: TEST_USER.id,
      creator: TEST_USER,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "active",
      object:
        input.kind === "OBJECT"
          ? { id: input.objectId, objectKey: "test-key" }
          : null,
      archiveRequest:
        input.kind === "ARCHIVE"
          ? {
              id: "test-archive-id",
              prefix: input.prefix ?? null,
              format: input.format ?? "zip",
              filename: input.archiveFilename ?? `${bucket}.zip`,
              objectCount: input.keys?.length ?? 0,
              totalSizeBytes: "0",
              expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            }
          : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async getBucketLifecyclePolicy(bucket: string): Promise<LifecyclePolicy> {
    if (this.testMode) {
      return {
        expireObjectsAfterDays: null,
        expireVersionsAfterDays: null,
        purgeSoftDeletedAfterDays: null,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    return await requests.files.getBucketLifecyclePolicy(bucket);
  }

  async upsertBucketLifecyclePolicy(
    bucket: string,
    input: UpsertLifecyclePolicyInput
  ): Promise<LifecyclePolicy> {
    if (this.testMode) {
      return {
        expireObjectsAfterDays: input.expireObjectsAfterDays ?? null,
        expireVersionsAfterDays: input.expireVersionsAfterDays ?? null,
        purgeSoftDeletedAfterDays: input.purgeSoftDeletedAfterDays ?? null,
        enabled: input.enabled ?? true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    return await requests.files.upsertBucketLifecyclePolicy(bucket, input);
  }

  async deleteBucketLifecyclePolicy(bucket: string): Promise<void> {
    if (this.testMode) return;
    await requests.files.deleteBucketLifecyclePolicy(bucket);
  }

  // ---------------------------------------------------------------------------
  // Multipart uploads
  // ---------------------------------------------------------------------------

  async initiateMultipart(
    bucket: string,
    key: string,
    input: InitiateMultipartInput
  ): Promise<InitiateMultipartResponse> {
    if (this.testMode) {
      return {
        uploadId: "test-upload",
        bucket,
        objectKey: key,
        contentType: input.contentType,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      };
    }
    return await requests.files.initiateMultipart(bucket, key, input);
  }

  async uploadPart(
    bucket: string,
    uploadId: string,
    partNumber: number,
    input: UploadPartInput
  ): Promise<UploadPartResponse> {
    if (this.testMode) {
      return {
        partNumber,
        etag: "test-part-etag",
        sizeBytes: String(input.body.length),
        minPartSize: 5 * 1024 * 1024,
      };
    }
    return await requests.files.uploadPart(bucket, uploadId, partNumber, input);
  }

  async listMultipartParts(
    bucket: string,
    uploadId: string
  ): Promise<MultipartUploadInfo> {
    if (this.testMode) {
      return {
        uploadId,
        objectKey: "test",
        contentType: "application/octet-stream",
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        completedAt: null,
        abortedAt: null,
        parts: [],
      };
    }
    return await requests.files.listMultipartParts(bucket, uploadId);
  }

  async completeMultipart(
    bucket: string,
    uploadId: string,
    input: CompleteMultipartInput
  ): Promise<CompleteMultipartResponse> {
    if (this.testMode) {
      return {
        id: "00000000-0000-4000-8000-000000000000",
        key: "test",
        contentType: "application/octet-stream",
        sizeBytes: "0",
        etag: "test-etag",
        metadata: null,
        tags: [],
        createdAt: new Date().toISOString(),
      };
    }
    return await requests.files.completeMultipart(bucket, uploadId, input);
  }

  async abortMultipart(bucket: string, uploadId: string): Promise<void> {
    if (this.testMode) return;
    await requests.files.abortMultipart(bucket, uploadId);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private makeMockObject(
    bucket: string,
    key: string,
    data: UploadObjectInput
  ): FileServiceObject {
    return {
      id: "00000000-0000-4000-8000-000000000000",
      key,
      contentType: data.contentType ?? "application/octet-stream",
      sizeBytes: String(data.file.length),
      etag: `test-etag-${bucket}-${key}`,
      metadata: data.metadata ?? null,
      tags: data.tags ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private makeMockBucket(name: string): Bucket {
    return {
      id: 1,
      name,
      description: null,
      policy: "private",
      currentUsageBytes: "0",
      versioningEnabled: false,
      autoThumbnails: false,
      corsConfig: null,
      rateLimitConfig: null,
      createdBy: TEST_USER.id,
      creator: TEST_USER,
      ownerId: TEST_USER.id,
      owner: TEST_USER,
      organizationId: null,
      organization: null,
      serviceId: null,
      serviceName: null,
      service: null,
      missingSince: null,
      retiredAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}
