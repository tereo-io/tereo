import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_CLIENT, CORE_ONCE_CLIENT } from "../../../handler.js";
import { urlPath } from "../../paths.js";
import { randomUUID } from "crypto";
import {
  CompleteMultipartInput,
  CompleteMultipartResponse,
  InitiateMultipartInput,
  InitiateMultipartResponse,
  MultipartUploadInfo,
  UploadPartInput,
  UploadPartResponse,
} from "./types.js";

export * from "./types.js";

/**
 * Initiate a multipart upload. Sent to the bucket-level `/multipart` route;
 * the object key travels in the body so the URL has no splat. Downstream
 * part-upload, complete, and abort routes continue to address the upload by
 * its returned UUID `uploadId`.
 */
export const initiateMultipart = async (
  bucket: string,
  key: string,
  input: InitiateMultipartInput
): Promise<InitiateMultipartResponse> => {
  const res = await tryHandleRequest<InitiateMultipartResponse>(
    {
      clientName: CORE_ONCE_CLIENT,
      requestName: "core.files.initiateMultipart",
      method: "POST",
      url: urlPath`/v1/files/buckets/${bucket}/multipart`,
      data: {
        objectKey: key,
        contentType: input.contentType,
        expectedSize: input.expectedSize?.toString(),
        metadata: input.metadata,
        tags: input.tags,
      },
    },
    "FS_0100",
    `Failed to initiate multipart upload for ${bucket}/${key}`
  );
  return res.data;
};

/**
 * Per-request timeout for a single multipart part upload. Keeps a slow client
 * from holding a slot in the shared `CORE_CLIENT` request-handler queue
 * indefinitely. Scoped to this call only — the client-level default stays at
 * whatever the shared `CORE_CLIENT` axios config has so that other requests
 * (download, metadata, etc.) are not affected.
 */
const UPLOAD_PART_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export const uploadPart = async (
  bucket: string,
  uploadId: string,
  partNumber: number,
  input: UploadPartInput
): Promise<UploadPartResponse> => {
  const res = await tryHandleRequest<UploadPartResponse>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.uploadPart",
      method: "PUT",
      url: urlPath`/v1/files/buckets/${bucket}/multipart/${uploadId}/parts/${partNumber}`,
      data: input.body,
      // Always octet-stream: core's JSON and form parsers would consume a
      // part sent as their types before it is staged.
      headers: { "Content-Type": "application/octet-stream" },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: UPLOAD_PART_TIMEOUT_MS,
    },
    "FS_0101",
    `Failed to upload part ${partNumber} of ${bucket}/${uploadId}`
  );
  return res.data;
};

export const listMultipartParts = async (
  bucket: string,
  uploadId: string
): Promise<MultipartUploadInfo> => {
  const res = await tryHandleRequest<MultipartUploadInfo>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.listMultipartParts",
      method: "GET",
      url: urlPath`/v1/files/buckets/${bucket}/multipart/${uploadId}`,
    },
    "FS_0102",
    `Failed to list multipart parts for ${bucket}/${uploadId}`
  );
  return res.data;
};

export const completeMultipart = async (
  bucket: string,
  uploadId: string,
  input: CompleteMultipartInput
): Promise<CompleteMultipartResponse> => {
  const { idempotencyKey, ...body } = input;
  const res = await tryHandleRequest<CompleteMultipartResponse>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.completeMultipart",
      method: "POST",
      url: urlPath`/v1/files/buckets/${bucket}/multipart/${uploadId}/complete`,
      data: body,
      headers: {
        "Idempotency-Key": idempotencyKey ?? randomUUID(),
      },
    },
    "FS_0103",
    `Failed to complete multipart upload ${bucket}/${uploadId}`
  );
  return res.data;
};

export const abortMultipart = async (
  bucket: string,
  uploadId: string
): Promise<void> => {
  await tryHandleRequest(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.abortMultipart",
      method: "DELETE",
      url: urlPath`/v1/files/buckets/${bucket}/multipart/${uploadId}`,
    },
    "FS_0104",
    `Failed to abort multipart upload ${bucket}/${uploadId}`
  );
};
