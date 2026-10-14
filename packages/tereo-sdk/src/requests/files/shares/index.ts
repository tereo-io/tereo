import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_CLIENT, CORE_ONCE_CLIENT } from "../../../handler.js";
import { urlPath } from "../../paths.js";
import type {
  CreateShareInput,
  ListSharesOptions,
  ListSharesResponse,
  Share,
  UpdateShareInput,
} from "./types.js";

export * from "./types.js";

/**
 * Create a revocable share link for an object (kind=OBJECT) or a server-
 * built archive (kind=ARCHIVE). The returned Share.url is the public
 * /shared/:token link you hand to recipients.
 */
export const createShare = async (
  bucket: string,
  input: CreateShareInput
): Promise<Share> => {
  const res = await tryHandleRequest<Share>(
    {
      clientName: CORE_ONCE_CLIENT,
      requestName: "core.files.createShare",
      method: "POST",
      url: urlPath`/v1/files/buckets/${bucket}/shares`,
      data: input,
    },
    "FS_0120",
    `Failed to create share for ${bucket}`
  );
  return res.data;
};

export const listShares = async (
  bucket: string,
  options?: ListSharesOptions
): Promise<ListSharesResponse> => {
  const res = await tryHandleRequest<ListSharesResponse>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.listShares",
      method: "GET",
      url: urlPath`/v1/files/buckets/${bucket}/shares`,
      params: options,
    },
    "FS_0121",
    `Failed to list shares for ${bucket}`
  );
  return res.data;
};

export const getShare = async (bucket: string, id: string): Promise<Share> => {
  const res = await tryHandleRequest<Share>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.getShare",
      method: "GET",
      url: urlPath`/v1/files/buckets/${bucket}/shares/by-id/${id}`,
    },
    "FS_0122",
    `Failed to fetch share ${id}`
  );
  return res.data;
};

export const updateShare = async (
  bucket: string,
  id: string,
  input: UpdateShareInput
): Promise<Share> => {
  const res = await tryHandleRequest<Share>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.updateShare",
      method: "PATCH",
      url: urlPath`/v1/files/buckets/${bucket}/shares/by-id/${id}`,
      data: input,
    },
    "FS_0123",
    `Failed to update share ${id}`
  );
  return res.data;
};

export const revokeShare = async (
  bucket: string,
  id: string
): Promise<void> => {
  await tryHandleRequest<void>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.revokeShare",
      method: "DELETE",
      url: urlPath`/v1/files/buckets/${bucket}/shares/by-id/${id}`,
    },
    "FS_0124",
    `Failed to revoke share ${id}`
  );
};
