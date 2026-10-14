import type { UseInfiniteReturn } from "@kosmeo-ui/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";
import { useCallback, useRef } from "react";
import type {
  ListPrefixesResponse,
  PrefixListEntry,
} from "./useObjectPrefixes";

interface UseInfiniteObjectPrefixesOptions {
  enabled?: boolean;
}

const PAGE_LIMIT = 100;

const useInfiniteObjectPrefixes = (
  bucketName: string | undefined,
  prefix: string,
  options?: UseInfiniteObjectPrefixesOptions
): UseInfiniteReturn<PrefixListEntry> => {
  const { hasPermission, currentOrganization } = useAuth();
  const axios = useAxios("fileService");

  const enabled =
    (options?.enabled ?? true) &&
    hasPermission("file-service.objects.read") &&
    !!bucketName;

  const query = useInfiniteQuery<ListPrefixesResponse, Error>({
    // "infinite" suffix disambiguates from the single-shot useObjectPrefixes
    // cache (same key would collide under a different query type). Mutations
    // invalidate ["object-prefixes", bucketName], which still matches this
    // key by prefix so refreshes keep working.
    queryKey: [
      "object-prefixes",
      bucketName,
      prefix,
      "infinite",
      currentOrganization?.id ?? null,
    ],
    enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      params.append("prefix", prefix);
      params.append("delimiter", "/");
      params.append("limit", String(PAGE_LIMIT));
      if (pageParam) params.set("cursor", pageParam as string);
      const res = await axios.get<ListPrefixesResponse>(
        `/buckets/${bucketName}/objects/prefixes?${params.toString()}`
      );
      return res.data;
    },
  });

  const queryRef = useRef(query);
  queryRef.current = query;

  // InfiniteScroll fires onQueryChange both on initial mount (offset=0) and on
  // scroll-to-bottom (offset>0). Only the latter should advance the cursor.
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
    total: 0,
    onQueryChange,
    reload,
  };
};

export default useInfiniteObjectPrefixes;
