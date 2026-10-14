import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_CLIENT, CORE_ONCE_CLIENT } from "../../../handler.js";
import { urlPath } from "../../paths.js";
import {
  ListObjectVersionsOptions,
  ListObjectVersionsResponse,
  ObjectVersion,
  RestoreObjectVersionResponse,
} from "./types.js";

export * from "./types.js";

/**
 * All version routes are id-addressed:
 *   /buckets/:name/objects/by-id/:id/versions[/ :versionId ...]
 *
 * The second argument is the object's stable UUID `id`, not its `objectKey`.
 * Reads (download, HEAD) still address objects by key, but every mutation and
 * version-scope read uses the identity-stable id.
 */

export const listObjectVersions = async (
  bucket: string,
  id: string,
  options?: ListObjectVersionsOptions
): Promise<ListObjectVersionsResponse> => {
  const res = await tryHandleRequest<ListObjectVersionsResponse>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.listVersions",
      method: "GET",
      url: urlPath`/v1/files/buckets/${bucket}/objects/by-id/${id}/versions`,
      params: options,
    },
    "FS_0070",
    `Failed to list versions for ${bucket}:${id}`
  );
  return res.data;
};

export const getObjectVersion = async (
  bucket: string,
  id: string,
  versionId: string
): Promise<ObjectVersion> => {
  const res = await tryHandleRequest<ObjectVersion>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.getVersion",
      method: "GET",
      url: urlPath`/v1/files/buckets/${bucket}/objects/by-id/${id}/versions/${versionId}`,
    },
    "FS_0071",
    `Failed to get version ${versionId} of ${bucket}:${id}`
  );
  return res.data;
};

export const restoreObjectVersion = async (
  bucket: string,
  id: string,
  versionId: string
): Promise<RestoreObjectVersionResponse> => {
  const res = await tryHandleRequest<RestoreObjectVersionResponse>(
    {
      clientName: CORE_ONCE_CLIENT,
      requestName: "core.files.restoreVersion",
      method: "POST",
      url: urlPath`/v1/files/buckets/${bucket}/objects/by-id/${id}/versions/${versionId}/restore`,
    },
    "FS_0072",
    `Failed to restore version ${versionId} of ${bucket}:${id}`
  );
  return res.data;
};

export const deleteObjectVersion = async (
  bucket: string,
  id: string,
  versionId: string
): Promise<void> => {
  await tryHandleRequest(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.deleteVersion",
      method: "DELETE",
      url: urlPath`/v1/files/buckets/${bucket}/objects/by-id/${id}/versions/${versionId}`,
    },
    "FS_0073",
    `Failed to delete version ${versionId} of ${bucket}:${id}`
  );
};

/**
 * Download the raw bytes of a specific version. Id-addressed so the URL
 * survives a rename — unlike the key-addressed
 * `GET /objects/*objectKey?versionId=...` form, a shared link stays valid
 * after the object moves.
 */
export const downloadObjectVersion = async (
  bucket: string,
  id: string,
  versionId: string
): Promise<Buffer> => {
  const res = await tryHandleRequest<ArrayBuffer>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.downloadVersion",
      method: "GET",
      url: urlPath`/v1/files/buckets/${bucket}/objects/by-id/${id}/versions/${versionId}/download`,
      responseType: "arraybuffer",
    },
    "FS_0074",
    `Failed to download version ${versionId} of ${bucket}:${id}`
  );
  return Buffer.from(res.data);
};
