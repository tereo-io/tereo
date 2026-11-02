import type { FileServiceClientConfig } from "../types/files.js";

export const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const DEFAULT_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_PART_CONCURRENCY = 4;

export interface UploadOptions {
  thresholdBytes: number;
  partSizeBytes: number;
  partConcurrency: number;
}

export const resolveUploadOptions = (
  config?: FileServiceClientConfig
): UploadOptions => {
  const thresholdBytes =
    config?.multipartThresholdBytes ?? DEFAULT_MULTIPART_THRESHOLD_BYTES;
  const partSizeBytes = config?.partSizeBytes ?? DEFAULT_PART_SIZE_BYTES;
  const partConcurrency = config?.partConcurrency ?? DEFAULT_PART_CONCURRENCY;

  if (!Number.isInteger(partSizeBytes) || partSizeBytes < MIN_PART_SIZE_BYTES) {
    throw new Error(
      `@tereo-io/sdk: partSizeBytes must be an integer of at least ${MIN_PART_SIZE_BYTES} (5 MiB)`
    );
  }
  if (!Number.isInteger(thresholdBytes) || thresholdBytes < partSizeBytes) {
    throw new Error(
      `@tereo-io/sdk: multipartThresholdBytes must be an integer of at least partSizeBytes (${partSizeBytes})`
    );
  }
  if (!Number.isInteger(partConcurrency) || partConcurrency < 1) {
    throw new Error(
      "@tereo-io/sdk: partConcurrency must be an integer of at least 1"
    );
  }
  return { thresholdBytes, partSizeBytes, partConcurrency };
};
