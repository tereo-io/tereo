import type { UseInfiniteReturn } from "@kosmeo-ui/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { useAuth, useAxios } from "@/lib/auth";
import { Bucket } from "./types";

interface BucketListResponse {
  data: Bucket[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

const normalizeQuery = (queryString: string): string => {
  const params = new URLSearchParams(queryString);
  params.delete("offset");
  return params.toString();
};

const useInfiniteBuckets = (): UseInfiniteReturn<Bucket> => {
  const { hasPermission, currentOrganization } = useAuth();
  const axios = useAxios("fileService");

  const [queryString, setQueryString] = useState("limit=10");
  const lastQueryRef = useRef(queryString);

  const enabled = hasPermission("file-service.buckets.read");

  const query = useInfiniteQuery<BucketListResponse, Error>({
    queryKey: [
      "buckets-infinite",
      currentOrganization?.id ?? null,
      queryString,
    ],
    enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams(queryString);
      params.delete("offset");
      if (pageParam) params.set("cursor", pageParam as string);
      const res = await axios.get<BucketListResponse>(
        `/buckets?${params.toString()}`
      );
      return res.data;
    },
    staleTime: 0,
    gcTime: 0,
  });

  const queryRef = useRef(query);
  queryRef.current = query;

  const onQueryChange = useCallback((newQueryString: string) => {
    const normalized = normalizeQuery(newQueryString);
    if (normalized === lastQueryRef.current) {
      const q = queryRef.current;
      if (q.hasNextPage && !q.isFetchingNextPage) q.fetchNextPage();
      return;
    }
    lastQueryRef.current = normalized;
    setQueryString(normalized);
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

export default useInfiniteBuckets;
