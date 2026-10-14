import { ListPrefixesOptions, ListPrefixesResponse } from "./types.js";
import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_CLIENT } from "../../../handler.js";
import { urlPath } from "../../paths.js";

export * from "./types.js";

export const listObjectPrefixes = async (
  bucket: string,
  options?: ListPrefixesOptions
): Promise<ListPrefixesResponse> => {
  const res = await tryHandleRequest<ListPrefixesResponse>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.files.listPrefixes",
      method: "GET",
      url: urlPath`/v1/files/buckets/${bucket}/objects/prefixes`,
      params: options,
    },
    "FS_0060",
    `Failed to list prefixes in bucket ${bucket}`
  );
  return res.data;
};
