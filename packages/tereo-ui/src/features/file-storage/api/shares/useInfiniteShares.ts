import type { UseInfiniteReturn } from "@kosmeo-ui/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ListSharesResponse, Share } from "./types";
import { useCallback, useRef, useState } from "react";
import { useAuth, useAxios } from "@/lib/auth";

const useInfiniteShares = (bucketName: string): UseInfiniteReturn<Share> => {
  const { hasPermission, currentOrganization } = useAuth();
  const axios = useAxios("fileService");

  const [queryString, setQueryString] = useState("limit=25");
  const lastQueryRef = useRef(queryString);

  const enabled = hasPermission("file-service.shares.read");

  const query = useInfiniteQuery<ListSharesResponse, Error>({
    queryKey: [
      `shares-${bucketName}-infinite`,
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
      const res = await axios.get<ListSharesResponse>(
        `/buckets/${bucketName}/shares?${params.toString()}`
      );
      return res.data;
    },
    staleTime: 0,
    gcTime: 0,
  });

  const queryRef = useRef(query);
  queryRef.current = query;

  const onQueryChange = useCallback((newQueryString: string) => {
    const params = new URLSearchParams(newQueryString);
    params.delete("offset");
    const normalized = params.toString();
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
    error: query.error,
    total: 0,
    onQueryChange,
    reload,
  };
};

export default useInfiniteShares;
