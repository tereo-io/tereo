import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { asciiJson, tagsHeader } from "../../../utils/headers.js";
import { urlPath, type EncodedPath } from "../../paths.js";
import { CORE_CLIENT } from "../../../handler.js";
import { v7 as uuidv7 } from "uuid";
import FormData from "form-data";
import {
  getOriginalStatus,
  InvalidRequestInputError,
} from "../../../utils/errors.js";
import {
  BulkDeleteInput,
  BulkDeleteResponse,
  FileServiceObject,
  ListObjectsOptions,
  ListObjectsResponse,
  PatchObjectInput,
  PurgeNonCurrentVersionsResponse,
  UploadObjectInput,
} from "./types.js";

export * from "./types.js";

/**
 * An object key as a URL path: each segment escaped, the slashes kept. Refuses
 * the keys core refuses by shape — empty, `..` anywhere, a leading, trailing
 * or doubled `/` — and a `.` segment, which the URL parser would drop.
 */
export const keyPath = (key: string): string => {
  const segments = key.split("/");
  if (key.includes("..") || segments.some((s) => s === "" || s === ".")) {
    throw new InvalidRequestInputError(
      `Object key ${JSON.stringify(key)} is not a valid key: it must not be empty, contain "..", start or end with "/", contain "//" or a "." segment`
    );
  }
  return segments.map(encodeURIComponent).join("/");
};

const keyFragment = (key: string): EncodedPath => ({ encoded: keyPath(key) });

/**
 * `"objectKey:contains": "x"` → core's `filter[objectKey]=x` and
 * `filter[objectKey_op]=contains`. Core takes one operator per field.
 */
export const listObjectsParams = (
  options: ListObjectsOptions = {}
): Record<string, unknown> => {
  const params: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined) continue;
    const [field, op] = name.split(":");
    if (!op) {
      params[name] = value;
      continue;
    }
    if (params[`filter[${field}]`] !== undefined) {
      throw new Error(
        `listObjects: core filters ${field} by one operator at a time`
      );
    }
    params[`filter[${field}]`] = value;
    if (op !== "equals") params[`filter[${field}_op]`] = op;
  }
  return params;
};

/**
 * Per-request timeout for an upload, which may carry a large file; the core
 * client's default applies to every other call.
 */
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export const uploadObject = async (
  bucket: string,
  key: string,
  input: UploadObjectInput
): Promise<FileServiceObject> => {
  const form = new FormData();
  form.append("file", input.file, {
    filename: key,
    ...(input.contentType ? { contentType: input.contentType } : {}),
  });

  // A Buffer rather than the form's stream, so a retry (after a 5xx, a dropped
  // connection or a rejected token) sends the whole body again.
  const body = form.getBuffer();
  const headers: Record<string, string> = { ...form.getHeaders() };
  if (input.metadata) headers["X-Metadata"] = asciiJson(input.metadata);
  if (input.tags && input.tags.length > 0) {
    headers["X-Tags"] = tagsHeader(input.tags);
  }
  if (input.ifMatch) headers["If-Match"] = input.ifMatch;
  if (input.ifNoneMatch) headers["If-None-Match"] = input.ifNoneMatch;
  // Generated once per call, so the handler's transport retries dedupe.
  headers["Idempotency-Key"] = input.idempotencyKey ?? uuidv7();

  const res = await tryHandleRequest<FileServiceObject>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.uploadObject",
      method: "PUT",
      url: urlPath`/v1/files/buckets/${bucket}/objects/${keyFragment(key)}`,
      data: body,
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: UPLOAD_TIMEOUT_MS,
    },
    "FS_0010",
    `Failed to upload object ${bucket}/${key}`
  );
  return res.data;
};

export const downloadObject = async (
  bucket: string,
  key: string
): Promise<Buffer> => {
  const res = await tryHandleRequest<ArrayBuffer>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.downloadObject",
      method: "GET",
      url: urlPath`/v1/files/buckets/${bucket}/objects/${keyFragment(key)}`,
      responseType: "arraybuffer",
    },
    "FS_0011",
    `Failed to download object ${bucket}/${key}`
  );
  return Buffer.from(res.data);
};

export const getObjectMetadata = async (
  bucket: string,
  key: string
): Promise<Record<string, string>> => {
  const res = await tryHandleRequest<unknown>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.headObject",
      method: "HEAD",
      url: urlPath`/v1/files/buckets/${bucket}/objects/${keyFragment(key)}`,
    },
    "FS_0012",
    `Failed to fetch object metadata for ${bucket}/${key}`
  );
  return (res.headers || {}) as Record<string, string>;
};

export const listObjects = async (
  bucket: string,
  options?: ListObjectsOptions
): Promise<ListObjectsResponse> => {
  const res = await tryHandleRequest<ListObjectsResponse>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.listObjects",
      method: "GET",
      url: urlPath`/v1/files/buckets/${bucket}/objects`,
      params: listObjectsParams(options),
    },
    "FS_0013",
    `Failed to list objects in bucket ${bucket}`
  );
  return res.data;
};

/**
 * Delete an object by its stable UUID `id`. Routes to the id-addressed
 * endpoint (`DELETE /buckets/:name/objects/by-id/:id`) — the old key-based
 * DELETE is gone; reads still use `key`.
 */
export const deleteObject = async (
  bucket: string,
  id: string
): Promise<void> => {
  await tryHandleRequest<void>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.deleteObject",
      method: "DELETE",
      url: urlPath`/v1/files/buckets/${bucket}/objects/by-id/${id}`,
    },
    "FS_0014",
    `Failed to delete object ${bucket}:${id}`
  );
};

/**
 * Fetch an object's metadata by its stable UUID `id`.
 * GET /buckets/:name/objects/by-id/:id
 */
export const getObject = async (
  bucket: string,
  id: string
): Promise<FileServiceObject> => {
  const res = await tryHandleRequest<FileServiceObject>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.getObject",
      method: "GET",
      url: urlPath`/v1/files/buckets/${bucket}/objects/by-id/${id}`,
    },
    "FS_0015",
    `Failed to fetch object ${bucket}:${id}`
  );
  return res.data;
};

/**
 * Patch an object: rename (`objectKey`) and/or update current-version
 * metadata. The UUID `id` is stable across renames, so existing references
 * remain valid.
 * PATCH /buckets/:name/objects/by-id/:id
 */
export const patchObject = async (
  bucket: string,
  id: string,
  input: PatchObjectInput
): Promise<FileServiceObject> => {
  const res = await tryHandleRequest<FileServiceObject>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.patchObject",
      method: "PATCH",
      url: urlPath`/v1/files/buckets/${bucket}/objects/by-id/${id}`,
      data: input,
    },
    "FS_0016",
    `Failed to patch object ${bucket}:${id}`
  );
  return res.data;
};

/**
 * Bulk soft-delete objects in a bucket by prefix or id list.
 * POST /buckets/:name/objects/bulk-delete
 */
export const bulkDeleteObjects = async (
  bucket: string,
  input: BulkDeleteInput
): Promise<BulkDeleteResponse> => {
  const res = await tryHandleRequest<BulkDeleteResponse>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.bulkDelete",
      method: "POST",
      url: urlPath`/v1/files/buckets/${bucket}/objects/bulk-delete`,
      data: input,
    },
    "FS_0018",
    `Failed to bulk-delete objects in bucket ${bucket}`
  );
  return res.data;
};

/**
 * Purge every non-current, live version row in a bucket. Releases blob refs;
 * orphan blobs are reclaimed by the orphan-blob worker. Server caps each call
 * at 10,000 versions and sets `truncated: true` when more remain.
 * POST /buckets/:name/objects/purge-non-current-versions
 */
export const purgeNonCurrentVersions = async (
  bucket: string
): Promise<PurgeNonCurrentVersionsResponse> => {
  const res = await tryHandleRequest<PurgeNonCurrentVersionsResponse>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.purgeNonCurrentVersions",
      method: "POST",
      url: urlPath`/v1/files/buckets/${bucket}/objects/purge-non-current-versions`,
    },
    "FS_0019",
    `Failed to purge non-current versions in bucket ${bucket}`
  );
  return res.data;
};

/**
 * Resolve a (bucket, key) pair to a `FileServiceObject`. Hits the server's
 * dedicated by-key metadata route; returns `null` on 404.
 */
export const resolveKey = async (
  bucket: string,
  key: string
): Promise<FileServiceObject | null> => {
  try {
    const res = await tryHandleRequest<FileServiceObject>(
      {
        clientName: CORE_CLIENT,
        requestName: "core.files.resolveKey",
        method: "GET",
        url: urlPath`/v1/files/buckets/${bucket}/objects/by-key/${keyFragment(key)}`,
      },
      "FS_0017",
      `Failed to resolve key ${bucket}/${key}`
    );
    return res.data;
  } catch (err) {
    if (getOriginalStatus(err) === 404) return null;
    throw err;
  }
};
