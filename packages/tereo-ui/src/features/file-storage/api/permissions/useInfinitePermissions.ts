import type { UseInfiniteReturn } from "@kosmeo-ui/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { useAuth, useAxios } from "@/lib/auth";
import { BucketPermission } from "./types";

interface PermissionListResponse {
  data: BucketPermission[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

const useInfinitePermissions = (
  bucketName: string
): UseInfiniteReturn<BucketPermission> => {
  const { hasPermission, currentOrganization } = useAuth();
  const axios = useAxios("fileService");

  const [queryString, setQueryString] = useState("limit=10");
  const lastQueryRef = useRef(queryString);

  const enabled = hasPermission("file-service.permissions.read");

  const query = useInfiniteQuery<PermissionListResponse, Error>({
    queryKey: [
      `permissions-${bucketName}-infinite`,
      currentOrganization?.id ?? null,
      queryString,
    ],
    enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams(queryString);
      params.delete("offset");
      // Core validates each id of the `in` list: drop empty entries ("a,,b").
      const userIds = params.get("filter[userId]");
      if (userIds) {
        params.set(
          "filter[userId]",
          userIds
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean)
            .join(",")
        );
      }
      if (pageParam) params.set("cursor", pageParam as string);
      const res = await axios.get<PermissionListResponse>(
        `/buckets/${bucketName}/permissions?${params.toString()}`
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

export default useInfinitePermissions;
