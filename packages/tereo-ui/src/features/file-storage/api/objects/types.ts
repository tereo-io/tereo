export interface FileServiceObject {
  /** Stable UUID — drives all id-addressed mutations. */
  id: string;
  key: string;
  contentType: string;
  sizeBytes: string;
  etag: string;
  metadata: Record<string, unknown> | null;
  tags: string[];
  /**
   * Per-object TTL override (ISO timestamp). When set, the object is
   * soft-deleted after this time regardless of bucket lifecycle policy.
   */
  deleteAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UploadObjectInput {
  bucketName: string;
  objectKey: string;
  file: File;
  metadata?: Record<string, string>;
  tags?: string[];
  ifMatch?: string;
  ifNoneMatch?: string | "*";
}
