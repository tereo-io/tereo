import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

export type BulkDeleteInput = { prefix: string } | { ids: string[] };

export interface BulkDeleteResponse {
  deletedCount: number;
  /** True when a prefix request hit the server's 10,000-object cap. */
  truncated: boolean;
}

/**
 * Bulk soft-delete objects by prefix (folder) or by explicit id list.
 * Invalidates every prefix/search cache entry for this bucket — unlike the
 * single-delete path, surgically stripping rows from cached pages isn't worth
 * the complexity when N rows may disappear at once. A full refetch of the
 * current view is simpler and correct.
 */
const useBulkDeleteObjects = (bucketName: string) => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();

  return useMutation<BulkDeleteResponse, AxiosError, BulkDeleteInput>({
    mutationFn: async (input) => {
      const res = await axios.post<BulkDeleteResponse>(
        `/buckets/${bucketName}/objects/bulk-delete`,
        input
      );
      return res.data;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["object-prefixes", bucketName],
      });
      queryClient.invalidateQueries({
        queryKey: ["object-search-infinite", bucketName],
      });
      queryClient.invalidateQueries({
        queryKey: [`objects-${bucketName}-infinite`],
      });
      queryClient.invalidateQueries({ queryKey: ["buckets"] });
      queryClient.invalidateQueries({ queryKey: ["buckets-infinite"] });
      queryClient.invalidateQueries({ queryKey: ["bucket", bucketName] });

      if (data.truncated && "prefix" in variables) {
        toast.warning(
          `Deleted ${data.deletedCount.toLocaleString()} objects. More remain under "${variables.prefix}" — run delete again to continue.`
        );
      } else {
        toast.success(
          `Deleted ${data.deletedCount.toLocaleString()} object${
            data.deletedCount === 1 ? "" : "s"
          }`
        );
      }
    },
    onError: (error) => {
      const data = error.response?.data as
        { error_description?: string } | undefined;
      toast.error(data?.error_description || "Failed to delete objects");
    },
  });
};

export default useBulkDeleteObjects;
