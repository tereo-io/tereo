import type { UseInfiniteReturn } from "@kosmeo-ui/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { useAuth, useAxios } from "@/lib/auth";
import type { UserRef } from "@/lib/refs";

export interface ObjectVersion {
  versionId: string;
  contentBlobHash: string | null;
  etag: string | null;
  sizeBytes: string | null;
  contentType: string | null;
  metadata: unknown;
  tags: string[];
  isCurrent: boolean;
  isDeleteMarker: boolean;
  restoredFromVersionId: string | null;
  createdAt: string;
  /** Uploader's user id. */
  createdBy: string;
  /** The uploader; null unless the viewer reads the bucket. */
  createdByEmail: string | null;
  createdByName: string | null;
  creator: UserRef | null;
}

interface VersionListResponse {
  data: ObjectVersion[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

interface UseInfiniteObjectVersionsOptions {
  enabled?: boolean;
}

const useInfiniteObjectVersions = (
  bucketName: string,
  objectId: string,
  options?: UseInfiniteObjectVersionsOptions
): UseInfiniteReturn<ObjectVersion> => {
  const { hasPermission, currentOrganization } = useAuth();
  const axios = useAxios("fileService");

  const [queryString, setQueryString] = useState("limit=25");
  const lastQueryRef = useRef(queryString);

  const enabled =
    (options?.enabled ?? true) &&
    hasPermission("file-service.objects.read") &&
    !!bucketName &&
    !!objectId;

  const query = useInfiniteQuery<VersionListResponse, Error>({
    // Prefix ["object-versions", bucketName, objectId] is what mutations
    // invalidate (per object, per bucket, or all).
    queryKey: [
      "object-versions",
      bucketName,
      objectId,
      "infinite",
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
      const res = await axios.get<VersionListResponse>(
        `/buckets/${bucketName}/objects/by-id/${objectId}/versions?${params.toString()}`
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

export default useInfiniteObjectVersions;
