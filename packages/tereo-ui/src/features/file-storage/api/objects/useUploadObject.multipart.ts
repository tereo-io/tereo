import type { UploadObjectInput, FileServiceObject } from "./types.js";
import { retryWithBackoff } from "./retryWithBackoff.js";
import type { AxiosInstance } from "axios";

// Files larger than this threshold use the multipart upload flow. Below this
// we keep the single-shot PUT path. 50 MB leaves headroom under the server's
// default 100 MB single-request cap and ensures we only pay the extra round
// trips (initiate + complete) when the payload is actually large.
export const MULTIPART_THRESHOLD_BYTES = 50 * 1024 * 1024;

// Part size for multipart uploads. Must be >= FILE_SERVICE_MIN_PART_SIZE_MB
// (5 MB default) on the server — the last part is exempt and can be smaller.
// 8 MB is a standard sweet spot: small enough for reasonable retry granularity,
// large enough to stay well under the 10,000-part cap for very large files
// (8 MB * 10,000 = ~80 GB ceiling before we'd need to bump this).
const PART_SIZE_BYTES = 8 * 1024 * 1024;

interface InitiateResponse {
  uploadId: string;
  bucket: string;
  objectKey: string;
  contentType: string;
  expiresAt: string;
}

interface UploadPartResponse {
  partNumber: number;
  etag: string;
  sizeBytes: string;
  minPartSize: number;
}

interface CompletedPart {
  partNumber: number;
  etag: string;
}

export async function uploadObjectMultipart(
  axios: AxiosInstance,
  input: UploadObjectInput
): Promise<FileServiceObject> {
  const { bucketName, objectKey, file, metadata, tags } = input;

  // Step 1: initiate. The server allocates an uploadId and persists the
  // content-type / metadata / tags — we don't re-send them per part. Object
  // key lives in the request body now; every multipart route is keyed only
  // by the upload UUID.
  const initiateBody: Record<string, unknown> = {
    objectKey,
    contentType: file.type || "application/octet-stream",
    expectedSize: file.size,
  };
  if (metadata && Object.keys(metadata).length > 0) {
    initiateBody.metadata = metadata;
  }
  if (tags && tags.length > 0) {
    initiateBody.tags = tags;
  }

  const initiateRes = await retryWithBackoff(() =>
    axios.post<InitiateResponse>(
      `/buckets/${bucketName}/multipart`,
      initiateBody
    )
  );
  const { uploadId } = initiateRes.data;

  const totalParts = Math.ceil(file.size / PART_SIZE_BYTES);
  const completedParts: CompletedPart[] = [];

  try {
    // Step 2: upload parts sequentially. `retryWithBackoff` covers rate-limit
    // (429 + Retry-After) and transient-failure cases for each part.
    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      const start = (partNumber - 1) * PART_SIZE_BYTES;
      const end = Math.min(start + PART_SIZE_BYTES, file.size);
      const blob = file.slice(start, end);

      const res = await retryWithBackoff(() =>
        axios.put<UploadPartResponse>(
          `/buckets/${bucketName}/multipart/${uploadId}/parts/${partNumber}`,
          blob,
          {
            headers: {
              "Content-Type": "application/octet-stream",
            },
          }
        )
      );
      completedParts.push({ partNumber, etag: res.data.etag });
    }

    // Step 3: complete. The server validates the parts list against what it
    // staged, concatenates them into the final encrypted blob, and returns the
    // same FileServiceObject shape the single-shot PUT returns. The server
    // requires Idempotency-Key on complete — we bind it to the uploadId so
    // retries of the complete step replay the first response.
    const completeRes = await retryWithBackoff(() =>
      axios.post<FileServiceObject>(
        `/buckets/${bucketName}/multipart/${uploadId}/complete`,
        { parts: completedParts },
        { headers: { "Idempotency-Key": `multipart:${uploadId}` } }
      )
    );
    return completeRes.data;
  } catch (err) {
    // Best-effort abort: free the staged parts on the server. Swallow any
    // error here so we always surface the original failure to the caller.
    try {
      await axios.delete(`/buckets/${bucketName}/multipart/${uploadId}`);
    } catch {
      // ignore — sweeper will clean up eventually
    }
    throw err;
  }
}
