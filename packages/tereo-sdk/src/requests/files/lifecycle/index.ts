import { LifecyclePolicy, UpsertLifecyclePolicyInput } from "./types.js";
import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_CLIENT } from "../../../handler.js";
import { urlPath } from "../../paths.js";

export * from "./types.js";

export const getBucketLifecyclePolicy = async (
  bucket: string
): Promise<LifecyclePolicy> => {
  const res = await tryHandleRequest<LifecyclePolicy>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.getLifecycle",
      method: "GET",
      url: urlPath`/v1/files/buckets/${bucket}/lifecycle`,
    },
    "FS_0090",
    `Failed to get lifecycle policy for bucket ${bucket}`
  );
  return res.data;
};

export const upsertBucketLifecyclePolicy = async (
  bucket: string,
  input: UpsertLifecyclePolicyInput
): Promise<LifecyclePolicy> => {
  const res = await tryHandleRequest<LifecyclePolicy>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.upsertLifecycle",
      method: "PUT",
      url: urlPath`/v1/files/buckets/${bucket}/lifecycle`,
      data: input,
    },
    "FS_0091",
    `Failed to upsert lifecycle policy for bucket ${bucket}`
  );
  return res.data;
};

export const deleteBucketLifecyclePolicy = async (
  bucket: string
): Promise<void> => {
  await tryHandleRequest(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.deleteLifecycle",
      method: "DELETE",
      url: urlPath`/v1/files/buckets/${bucket}/lifecycle`,
    },
    "FS_0092",
    `Failed to delete lifecycle policy for bucket ${bucket}`
  );
};
