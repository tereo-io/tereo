import { PresignObjectInput, PresignObjectResponse } from "./types.js";
import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_CLIENT } from "../../../handler.js";
import { urlPath } from "../../paths.js";

export * from "./types.js";

/**
 * Generate a presigned URL for anonymous read/write access. Addressed by the
 * object's stable UUID `id`, and so is the URL
 * (`/v1/files/signed/objects/:bucket/by-id/:id`, the HMAC binding the id): it
 * survives a rename.
 */
export const presignObjectUrl = async (
  bucket: string,
  id: string,
  input: PresignObjectInput = {}
): Promise<PresignObjectResponse> => {
  const res = await tryHandleRequest<PresignObjectResponse>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.presignObject",
      method: "POST",
      url: urlPath`/v1/files/buckets/${bucket}/objects/by-id/${id}/presign`,
      data: {
        operation: input.operation ?? "read",
        expiresInSeconds: input.expiresInSeconds ?? 3600,
      },
    },
    "FS_0080",
    `Failed to generate presigned URL for ${bucket}:${id}`
  );
  return res.data;
};
