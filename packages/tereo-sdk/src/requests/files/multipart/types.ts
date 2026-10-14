import {
  FileServiceObject,
  FileServiceObjectMetadata,
} from "../objects/types.js";

export interface InitiateMultipartInput {
  contentType: string;
  expectedSize?: string | number | bigint;
  metadata?: FileServiceObjectMetadata;
  tags?: string[];
}

export interface InitiateMultipartResponse {
  uploadId: string;
  bucket: string;
  objectKey: string;
  contentType: string;
  expiresAt: string;
}

export interface UploadPartInput {
  body: Buffer;
  /**
   * @deprecated Ignored: a part is sent as `application/octet-stream`. The
   * object's type is the one given to `initiateMultipart`.
   */
  contentType?: string;
}

export interface UploadPartResponse {
  partNumber: number;
  etag: string;
  sizeBytes: string;
  minPartSize: number;
}

export interface MultipartPartInfo {
  partNumber: number;
  etag: string;
  sizeBytes: string;
  uploadedAt: string;
}

export interface MultipartUploadInfo {
  uploadId: string;
  objectKey: string;
  contentType: string;
  expiresAt: string;
  completedAt: string | null;
  abortedAt: string | null;
  parts: MultipartPartInfo[];
}

export interface CompleteMultipartInput {
  parts: { partNumber: number; etag: string }[];
  /**
   * Idempotency key sent as `Idempotency-Key` header. The server requires
   * this header on multipart complete — the SDK generates a UUIDv7 if omitted.
   * Pass a deterministic key (e.g. `{uploadId}:complete`) when retries must
   * dedupe across process boundaries.
   */
  idempotencyKey?: string;
}

export type CompleteMultipartResponse = FileServiceObject;
