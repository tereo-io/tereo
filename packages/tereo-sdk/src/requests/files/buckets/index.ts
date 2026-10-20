import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_CLIENT, CORE_ONCE_CLIENT } from "../../../handler.js";
import { urlPath } from "../../paths.js";
import {
  Bucket,
  CreateBucketInput,
  ListBucketsOptions,
  ListBucketsResponse,
  MyBucketPermissions,
  UpdateBucketInput,
} from "./types.js";

export * from "./types.js";

export const listBuckets = async (
  options?: ListBucketsOptions
): Promise<ListBucketsResponse> => {
  const res = await tryHandleRequest<ListBucketsResponse>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.listBuckets",
      method: "GET",
      url: `/v1/files/buckets`,
      params: options as Record<string, unknown> | undefined,
    },
    "FS_0001",
    "Failed to list buckets"
  );
  return res.data;
};

export const getBucket = async (name: string): Promise<Bucket> => {
  const res = await tryHandleRequest<Bucket>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.getBucket",
      method: "GET",
      url: urlPath`/v1/files/buckets/${name}`,
    },
    "FS_0002",
    `Failed to fetch bucket ${name}`
  );
  return res.data;
};

export const createBucket = async (
  input: CreateBucketInput
): Promise<Bucket> => {
  const res = await tryHandleRequest<Bucket>(
    {
      clientName: CORE_ONCE_CLIENT,
      requestName: "core.files.createBucket",
      method: "POST",
      url: `/v1/files/buckets`,
      data: input,
    },
    "FS_0003",
    `Failed to create bucket ${input.name}`
  );
  return res.data;
};

export const updateBucket = async (
  name: string,
  input: UpdateBucketInput
): Promise<Bucket> => {
  const res = await tryHandleRequest<Bucket>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.updateBucket",
      method: "PUT",
      url: urlPath`/v1/files/buckets/${name}`,
      data: input,
    },
    "FS_0004",
    `Failed to update bucket ${name}`
  );
  return res.data;
};

export const deleteBucket = async (name: string): Promise<void> => {
  await tryHandleRequest<void>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.deleteBucket",
      method: "DELETE",
      url: urlPath`/v1/files/buckets/${name}`,
    },
    "FS_0005",
    `Failed to delete bucket ${name}`
  );
};

export const getMyBucketPermissions = async (
  name: string
): Promise<MyBucketPermissions> => {
  const res = await tryHandleRequest<MyBucketPermissions>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.getMyBucketPermissions",
      method: "GET",
      url: urlPath`/v1/files/buckets/${name}/my-permissions`,
    },
    "FS_0006",
    `Failed to fetch bucket permissions for ${name}`
  );
  return res.data;
};

export const transferBucketOwnership = async (
  name: string,
  userId: string
): Promise<Bucket> => {
  const res = await tryHandleRequest<Bucket>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.transferBucketOwnership",
      method: "PUT",
      url: urlPath`/v1/files/buckets/${name}/owner`,
      data: { userId },
    },
    "FS_0007",
    `Failed to transfer ownership of bucket ${name}`
  );
  return res.data;
};
