import type { UseInfiniteReturn } from "@kosmeo-ui/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";
import { useCallback, useRef } from "react";

/** An object deleted in a versioned bucket; restoring a version undeletes it. */
export interface DeletedObject {
  id: string;
  key: string;
  deletedAt: string;
  deletedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DeletedListResponse {
  data: DeletedObject[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

const PAGE_LIMIT = 50;

/** `GET /buckets/:name/objects?deleted=true` under `prefix`, in key order. */
const useInfiniteDeletedObjects = (
  bucketName: string | undefined,
  prefix: string,
  options?: { enabled?: boolean }
): UseInfiniteReturn<DeletedObject> => {
  const { hasPermission, currentOrganization } = useAuth();
  const axios = useAxios("fileService");

  const enabled =
    (options?.enabled ?? true) &&
    hasPermission("file-service.objects.read") &&
    !!bucketName;

  const query = useInfiniteQuery<DeletedListResponse, Error>({
    queryKey: [
      "deleted-objects",
      bucketName,
      prefix,
      currentOrganization?.id ?? null,
    ],
    enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({
        deleted: "true",
        limit: String(PAGE_LIMIT),
        sort: "objectKey",
        sortDir: "asc",
      });
      if (prefix) {
        params.set("filter[objectKey]", prefix);
        params.set("filter[objectKey_op]", "startsWith");
      }
      if (pageParam) params.set("cursor", pageParam as string);
      const res = await axios.get<DeletedListResponse>(
        `/buckets/${bucketName}/objects?${params.toString()}`
      );
      return res.data;
    },
    staleTime: 0,
    gcTime: 0,
  });

  const queryRef = useRef(query);
  queryRef.current = query;

  // InfiniteScroll asks for the next page with offset > 0; the first page is
  // driven by `enabled`.
  const onQueryChange = useCallback((newQueryString: string) => {
    const offset = new URLSearchParams(newQueryString).get("offset");
    if (!offset || offset === "0") return;
    const q = queryRef.current;
    if (q.hasNextPage && !q.isFetchingNextPage) q.fetchNextPage();
  }, []);

  const reload = useCallback(() => {
    queryRef.current.refetch();
  }, []);

  const allData = (query.data?.pages ?? []).flatMap((p) => p.data);
  const lastPage = query.data?.pages[query.data.pages.length - 1];
  const hasMore = lastPage?.hasMore ?? query.hasNextPage ?? false;

  return {
    data: allData,
    hasMore,
    isLoading: query.isLoading,
    isReloading: query.isRefetching && allData.length > 0,
    error: query.error,
    total: 0,
    onQueryChange,
    reload,
  };
};

export default useInfiniteDeletedObjects;
