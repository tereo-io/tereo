import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

interface DeleteObjectParams {
  bucketName: string;
  /** Stable UUID id. Every list/prefix response now carries `.id` alongside `.key`. */
  id: string;
  /** Current `objectKey`, kept for callers' toasts/logging. */
  objectKey: string;
}

// Minimal shape of a cached row we need to match against. Both prefix and
// search caches store at least an id on objects; prefix rows also carry a
// `type` discriminator ("prefix" | "object"). We leave non-object rows alone.
type Row = { id?: string; type?: string };

/**
 * Strip the deleted row from one cache entry. Handles both `useInfiniteQuery`
 * (pages array) and `useQuery` (single response) shapes so the same mutator
 * works across `useObjectPrefixes` and the infinite variants.
 */
const stripRowById = (id: string, old: unknown): unknown => {
  if (!old || typeof old !== "object") return old;
  const removeFromArr = (arr: Row[]) =>
    arr.filter(
      (r) => !(r.id === id && (r.type === "object" || r.type === undefined))
    );

  if ("pages" in old && Array.isArray((old as { pages: unknown[] }).pages)) {
    const o = old as { pages: Array<{ data: Row[] }> };
    return {
      ...o,
      pages: o.pages.map((p) => ({ ...p, data: removeFromArr(p.data) })),
    };
  }
  if ("data" in old && Array.isArray((old as { data: Row[] }).data)) {
    const o = old as { data: Row[] };
    return { ...o, data: removeFromArr(o.data) };
  }
  return old;
};

const useDeleteObject = (bucketName: string) => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();

  const mutationFn = async ({
    bucketName,
    id,
  }: DeleteObjectParams): Promise<void> => {
    await axios.delete(`/buckets/${bucketName}/objects/by-id/${id}`);
  };

  return useMutation({
    mutationFn,
    onSuccess: (_data, variables) => {
      // Surgically drop the row from every cached prefix/search page so the
      // user keeps their scroll position. Folder aggregate counts may be
      // slightly stale until the next fetch — acceptable trade-off.
      queryClient.setQueriesData(
        { queryKey: ["object-prefixes", bucketName] },
        (old) => stripRowById(variables.id, old)
      );
      queryClient.setQueriesData(
        { queryKey: ["object-search-infinite", bucketName] },
        (old) => stripRowById(variables.id, old)
      );

      // Legacy list cache + version cache still use broad invalidation.
      queryClient.invalidateQueries({
        queryKey: [`objects-${bucketName}-infinite`],
      });
      queryClient.invalidateQueries({
        queryKey: ["object-versions", bucketName, variables.id],
      });
      // Bucket-level aggregates (quota/object count) need a refetch.
      queryClient.invalidateQueries({ queryKey: ["buckets"] });
      queryClient.invalidateQueries({ queryKey: ["buckets-infinite"] });
      queryClient.invalidateQueries({ queryKey: ["bucket", bucketName] });
      toast.success("Object deleted successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to delete object"
      );
    },
  });
};

export default useDeleteObject;
