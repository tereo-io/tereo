import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FileServiceObject } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

export interface UpdateObjectInput {
  /** New object key (rename). */
  objectKey?: string;
  contentType?: string;
  /** Replaces the metadata; core rejects `null`, so send `{}` to clear. */
  metadata?: Record<string, unknown>;
  tags?: string[];
  /** ISO timestamp; null clears any per-object TTL override. */
  deleteAfter?: string | null;
  /**
   * On versioning-enabled buckets, branch a new version row instead of
   * editing the current one in place. Ignored elsewhere.
   */
  createNewVersion?: boolean;
}

interface UseUpdateObjectParams {
  /** Stable UUID — survives renames. */
  id: string;
  /** Used for cache invalidation; pre-rename key. */
  previousKey: string;
  data: UpdateObjectInput;
}

const useUpdateObject = (bucketName: string) => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: UseUpdateObjectParams): Promise<FileServiceObject> => {
      const res = await axios.patch<FileServiceObject>(
        `/buckets/${bucketName}/objects/by-id/${id}`,
        data
      );
      return res.data;
    },
    onSuccess: (_, variables) => {
      // The rename + metadata write affects every prefix view and the search
      // cache. We invalidate broadly rather than surgical-patch because the
      // row may move between prefixes after a rename.
      queryClient.invalidateQueries({
        queryKey: ["object-prefixes", bucketName],
      });
      queryClient.invalidateQueries({
        queryKey: ["object-search-infinite", bucketName],
      });
      queryClient.invalidateQueries({
        queryKey: [`objects-${bucketName}-infinite`],
      });
      queryClient.invalidateQueries({
        queryKey: ["object-versions", bucketName, variables.id],
      });
      toast.success("Object updated");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to update object"
      );
    },
  });
};

export default useUpdateObject;
