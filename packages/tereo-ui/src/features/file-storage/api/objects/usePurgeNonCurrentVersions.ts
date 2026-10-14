import { useMutation, useQueryClient } from "@tanstack/react-query";
import formatBytes from "@/utils/formatBytes";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

export interface PurgeNonCurrentVersionsResponse {
  purgedCount: number;
  /** Bytes refunded to bucket usage (server-side bigint as string). */
  bytesFreed: string;
  /** True when the server's 10,000-version cap was hit — re-invoke to continue. */
  truncated: boolean;
}

/**
 * Soft-delete every non-current version row in a versioned bucket. Current
 * versions are untouched, so cached current-object metadata stays valid; we
 * still invalidate `bucket` (usage breakdown) so the historical-bytes line
 * refreshes after the orphan-blob worker reclaims the bytes.
 */
const usePurgeNonCurrentVersions = (bucketName: string) => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();

  return useMutation<PurgeNonCurrentVersionsResponse, AxiosError, void>({
    mutationFn: async () => {
      const res = await axios.post<PurgeNonCurrentVersionsResponse>(
        `/buckets/${bucketName}/objects/purge-non-current-versions`
      );
      return res.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["bucket", bucketName] });
      queryClient.invalidateQueries({ queryKey: ["buckets"] });
      queryClient.invalidateQueries({ queryKey: ["buckets-infinite"] });
      // Per-object version lists are now empty (or shorter) — drop any cached
      // version pages so the Versions modal re-fetches on next open.
      queryClient.invalidateQueries({ queryKey: ["object-versions"] });

      const freed = formatBytes(data.bytesFreed);
      if (data.truncated) {
        toast.warning(
          `Purged ${data.purgedCount.toLocaleString()} versions (${freed} freed). More remain — run purge again to continue.`
        );
      } else {
        toast.success(
          `Purged ${data.purgedCount.toLocaleString()} non-current version${
            data.purgedCount === 1 ? "" : "s"
          } (${freed} freed)`
        );
      }
    },
    onError: (error) => {
      const data = error.response?.data as
        { error_description?: string } | undefined;
      toast.error(
        data?.error_description || "Failed to purge non-current versions"
      );
    },
  });
};

export default usePurgeNonCurrentVersions;
