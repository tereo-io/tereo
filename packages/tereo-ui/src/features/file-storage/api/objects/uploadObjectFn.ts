import type { UploadObjectInput, FileServiceObject } from "./types.js";
import { asciiJson, tagsError, tagsHeader } from "./uploadHeaders.js";
import { retryWithBackoff } from "./retryWithBackoff.js";
import encodeObjectKey from "./encodeObjectKey.js";
import type { AxiosInstance } from "axios";
import {
  MULTIPART_THRESHOLD_BYTES,
  uploadObjectMultipart,
} from "./useUploadObject.multipart.js";

const METADATA_MAX_BYTES = 100 * 1024; // 100KB — match server limit

/**
 * Upload a single object to file storage. Routes large payloads through the
 * S3-style multipart flow and the rest through a single-shot PUT. Throws on
 * error; callers are responsible for surfacing success/failure to the user.
 */
export async function uploadObjectFn(
  axios: AxiosInstance,
  input: UploadObjectInput
): Promise<FileServiceObject> {
  if (input.file.size > MULTIPART_THRESHOLD_BYTES) {
    return uploadObjectMultipart(axios, input);
  }

  const formData = new FormData();
  formData.append("file", input.file);

  const headers: Record<string, string> = {
    "Content-Type": "multipart/form-data",
  };

  if (input.metadata && Object.keys(input.metadata).length > 0) {
    const serialized = asciiJson(input.metadata);
    const byteLength = new Blob([serialized]).size;
    if (byteLength > METADATA_MAX_BYTES) {
      throw new Error(
        `Metadata exceeds ${METADATA_MAX_BYTES} byte limit (${byteLength} bytes)`
      );
    }
    headers["X-Metadata"] = serialized;
  }

  if (input.tags && input.tags.length > 0) {
    const tags = input.tags.map((t) => t.trim()).filter(Boolean);
    const error = tagsError(tags);
    if (error) throw new Error(error);
    headers["X-Tags"] = tagsHeader(tags);
  }

  if (input.ifMatch) headers["If-Match"] = input.ifMatch;
  if (input.ifNoneMatch) headers["If-None-Match"] = input.ifNoneMatch;

  // The server requires Idempotency-Key on every upload PUT. The same key
  // across retries is intentional — the server dedupes by (user, bucket,
  // endpoint, key) so a 429-retried request replays the original response if
  // it eventually landed instead of creating a duplicate.
  headers["Idempotency-Key"] = crypto.randomUUID();

  return retryWithBackoff(async () => {
    const res = await axios.put<FileServiceObject>(
      `/buckets/${input.bucketName}/objects/${encodeObjectKey(input.objectKey)}`,
      formData,
      { headers }
    );
    return res.data;
  });
}
