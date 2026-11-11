import { MAX_BLOB_BYTES } from "../../../../../../utils/encryption.js";
import {
  AppError,
  ConflictError,
  InsufficientStorageError,
} from "../../../../../../utils/errors.js";

/**
 * Refuse an upload whose parts would total `totalBytes`: more than one blob
 * can hold, more than the `expectedSize` it was initiated with, or more than
 * the bucket has left of its quota. Checked as each part is staged, so a
 * writer cannot stage more than the object could ever be, and again at
 * complete.
 */
export const assertMultipartFits = (
  upload: { expectedSize: bigint | null },
  bucket: { storageQuotaBytes: bigint | null; currentUsageBytes: bigint },
  totalBytes: bigint
) => {
  if (totalBytes > MAX_BLOB_BYTES) {
    throw new AppError(
      413,
      "object_too_large",
      `The parts total more than ${MAX_BLOB_BYTES} bytes, the largest object a bucket can store`
    );
  }
  if (upload.expectedSize !== null && totalBytes > upload.expectedSize) {
    throw new AppError(
      413,
      "exceeds_expected_size",
      `The parts total more than the expectedSize of ${upload.expectedSize} bytes the upload was initiated with`
    );
  }
  if (
    bucket.storageQuotaBytes !== null &&
    bucket.currentUsageBytes + totalBytes > bucket.storageQuotaBytes
  ) {
    throw new InsufficientStorageError("Storage quota exceeded");
  }
};

/**
 * Refuse a new upload when the bucket's usage, the `expectedSize`s of its
 * active uploads (`stagedBytes`) and the new upload's `expectedSize` would
 * together exceed its quota. An upload without an `expectedSize` stages
 * nothing against the quota.
 */
export const assertStagingFits = (
  bucket: { storageQuotaBytes: bigint | null; currentUsageBytes: bigint },
  stagedBytes: bigint,
  expectedSize: bigint | undefined
) => {
  if (
    bucket.storageQuotaBytes !== null &&
    bucket.currentUsageBytes + stagedBytes + (expectedSize ?? 0n) >
      bucket.storageQuotaBytes
  ) {
    throw new InsufficientStorageError("Storage quota exceeded");
  }
};

/**
 * Whether the bucket's quota bounds what `upload` may stage: it reserved its
 * `expectedSize` against one at initiate. Any other upload's parts count
 * against its creator's staged-bytes cap instead.
 */
export const isQuotaReserved = (
  upload: { expectedSize: bigint | null },
  bucket: { storageQuotaBytes: bigint | null }
) => bucket.storageQuotaBytes !== null && upload.expectedSize !== null;

/**
 * Refuse a part that would take the bytes its uploader has staged, across
 * their active uploads that no quota bounds, to `totalBytes`, past `maxBytes`.
 */
export const assertUserStagingFits = (totalBytes: bigint, maxBytes: bigint) => {
  if (totalBytes > maxBytes) {
    throw new ConflictError(
      `Your multipart uploads in progress would hold more than ${maxBytes} bytes of parts, the most allowed; complete or abort one first`,
      "multipart_staged_bytes_exceeded"
    );
  }
};

/** The claim a complete of `uploadId` holds while it runs. */
export const multipartCompleteClaim = (uploadId: string) =>
  `file-service:multipart-complete:${uploadId}`;
