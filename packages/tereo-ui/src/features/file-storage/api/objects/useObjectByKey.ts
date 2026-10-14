import { useQuery } from "@tanstack/react-query";
import type { FileServiceObject } from "./types";
import encodeObjectKey from "./encodeObjectKey";
import { useAuth, useAxios } from "@/lib/auth";

interface UseObjectByKeyOptions {
  enabled?: boolean;
}

/**
 * Resolves a (bucket, key) pair to the full object metadata, including the
 * stable UUID id needed for id-addressed mutations.
 */
const useObjectByKey = (
  bucketName: string,
  objectKey: string | undefined,
  options?: UseObjectByKeyOptions
) => {
  const { hasPermission } = useAuth();
  const axios = useAxios("fileService");

  return useQuery<FileServiceObject>({
    queryKey: ["object-by-key", bucketName, objectKey],
    enabled:
      (options?.enabled ?? true) &&
      hasPermission("file-service.objects.read") &&
      !!bucketName &&
      !!objectKey,
    queryFn: async () => {
      const res = await axios.get<FileServiceObject>(
        `/buckets/${bucketName}/objects/by-key/${encodeObjectKey(objectKey ?? "")}`
      );
      return res.data;
    },
  });
};

export default useObjectByKey;
