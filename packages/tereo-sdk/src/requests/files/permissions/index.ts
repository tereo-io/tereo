import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_CLIENT, CORE_ONCE_CLIENT } from "../../../handler.js";
import { urlPath } from "../../paths.js";
import {
  BucketPermission,
  GrantBucketPermissionInput,
  ListBucketPermissionsOptions,
  ListBucketPermissionsResponse,
} from "./types.js";

export * from "./types.js";

export const listBucketPermissions = async (
  bucket: string,
  options?: ListBucketPermissionsOptions
): Promise<ListBucketPermissionsResponse> => {
  const res = await tryHandleRequest<ListBucketPermissionsResponse>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.listPermissions",
      method: "GET",
      url: urlPath`/v1/files/buckets/${bucket}/permissions`,
      params: options as Record<string, unknown> | undefined,
    },
    "FS_0020",
    `Failed to list permissions for bucket ${bucket}`
  );
  return res.data;
};

export const grantBucketPermission = async (
  bucket: string,
  input: GrantBucketPermissionInput
): Promise<BucketPermission> => {
  const res = await tryHandleRequest<BucketPermission>(
    {
      clientName: CORE_ONCE_CLIENT,
      requestName: "core.files.grantPermission",
      method: "POST",
      url: urlPath`/v1/files/buckets/${bucket}/permissions`,
      data: input,
    },
    "FS_0021",
    `Failed to grant bucket permission on ${bucket}`
  );
  return res.data;
};

export const revokeBucketPermission = async (
  bucket: string,
  userId: string
): Promise<void> => {
  await tryHandleRequest<void>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.revokePermission",
      method: "DELETE",
      url: urlPath`/v1/files/buckets/${bucket}/permissions/${userId}`,
    },
    "FS_0022",
    `Failed to revoke bucket permission for user ${userId} on ${bucket}`
  );
};
