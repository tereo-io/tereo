import { CreateArchiveInput, CreateArchiveResponse } from "./types.js";
import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_ONCE_CLIENT } from "../../../handler.js";
import { urlPath } from "../../paths.js";

export * from "./types.js";

/**
 * Create an archive download request (folder-by-prefix or explicit key list)
 * and return a presigned URL that streams the zip/tar. The server snapshots
 * the object list at create time, so the archive contents are stable even if
 * objects are added or deleted before the URL is used.
 */
export const createArchive = async (
  bucket: string,
  input: CreateArchiveInput
): Promise<CreateArchiveResponse> => {
  const res = await tryHandleRequest<CreateArchiveResponse>(
    {
      clientName: CORE_ONCE_CLIENT,
      requestName: "core.files.createArchive",
      method: "POST",
      url: urlPath`/v1/files/buckets/${bucket}/archives`,
      data: input,
    },
    "FS_0110",
    `Failed to create archive for ${bucket}`
  );
  return res.data;
};
