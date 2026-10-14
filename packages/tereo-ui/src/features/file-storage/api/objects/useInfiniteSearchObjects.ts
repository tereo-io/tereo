import type { UseInfiniteReturn } from "@kosmeo-ui/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";
import { useCallback, useRef } from "react";

export interface SearchObjectResult {
  id: string;
  key: string;
  contentType: string;
  sizeBytes: string;
  etag: string;
  tags: string[];
  updatedAt: string;
}

interface SearchListResponse {
  data: SearchObjectResult[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

interface UseInfiniteSearchObjectsOptions {
  enabled?: boolean;
}

const PAGE_LIMIT = 50;

const buildQueryString = (prefix: string, term: string): string => {
  const params = new URLSearchParams();
  // Express 5's simple query parser collapses repeated keys into an array, which
  // the shared filter parser pairs by index into AND-merged Prisma clauses.
  if (prefix) {
    params.append("filter[objectKey]", prefix);
    params.append("filter[objectKey_op]", "startsWith");
  }
  params.append("filter[objectKey]", term);
  params.append("filter[objectKey_op]", "contains");
  params.append("limit", String(PAGE_LIMIT));
  params.append("sort", "objectKey");
  params.append("sortDir", "asc");
  return params.toString();
};

const useInfiniteSearchObjects = (
  bucketName: string | undefined,
  prefix: string,
  searchTerm: string,
  options?: UseInfiniteSearchObjectsOptions
): UseInfiniteReturn<SearchObjectResult> => {
  const { hasPermission, currentOrganization } = useAuth();
  const axios = useAxios("fileService");

  const trimmed = searchTerm.trim();
  const enabled =
    (options?.enabled ?? true) &&
    hasPermission("file-service.objects.read") &&
    !!bucketName &&
    trimmed.length > 0;

  const baseQueryString = enabled ? buildQueryString(prefix, trimmed) : "";

  const query = useInfiniteQuery<SearchListResponse, Error>({
    queryKey: [
      "object-search-infinite",
      bucketName,
      prefix,
      trimmed,
      currentOrganization?.id ?? null,
    ],
    enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams(baseQueryString);
      if (pageParam) params.set("cursor", pageParam as string);
      const res = await axios.get<SearchListResponse>(
        `/buckets/${bucketName}/objects?${params.toString()}`
      );
      return res.data;
    },
    staleTime: 0,
    gcTime: 0,
  });

  const queryRef = useRef(query);
  queryRef.current = query;

  // InfiniteScroll fires onQueryChange in two cases: (1) initial mount /
  // filter change with offset=0, and (2) scroll-to-bottom with offset>0.
  // We only want to advance the cursor on case 2 — the initial fetch is
  // already driven by useInfiniteQuery's enabled flag.
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

export default useInfiniteSearchObjects;
