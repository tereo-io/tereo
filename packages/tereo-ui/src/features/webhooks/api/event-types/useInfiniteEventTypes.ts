import type { CursorPage, EventType, EventTypeRow } from "../types";
import { useCallback, useMemo, useRef, useState } from "react";
import type { UseInfiniteReturn } from "@kosmeo-ui/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";

/**
 * `GET /event-types` for InfiniteScroll. Mirrors @kosmeo-ui/react's
 * `useInfiniteCursor`, which keys and dedupes rows by `id` — event types have
 * none (their primary key is `eventType`), so rows get `id = eventType` here.
 */
const useInfiniteEventTypes = (): UseInfiniteReturn<EventTypeRow> => {
  const { hasPermission } = useAuth();
  const axios = useAxios("webhooks");

  const [queryString, setQueryString] = useState("limit=50");
  const lastQueryRef = useRef(queryString);

  const query = useInfiniteQuery<CursorPage<EventType>, Error>({
    queryKey: ["webhook-event-types", "infinite", queryString],
    enabled: hasPermission("webhooks.event-types.read"),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) =>
      last.hasMore && last.nextCursor ? last.nextCursor : undefined,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams(queryString);
      if (pageParam) params.set("cursor", pageParam as string);
      const res = await axios.get<CursorPage<EventType>>(
        `/event-types?${params.toString()}`
      );
      return res.data;
    },
  });

  const queryRef = useRef(query);
  queryRef.current = query;

  const onQueryChange = useCallback((newQueryString: string) => {
    const params = new URLSearchParams(newQueryString);
    params.delete("offset");
    const normalized = params.toString();

    // Same filters and sort: InfiniteScroll wants the next page.
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

  const data = useMemo(
    () =>
      (query.data?.pages ?? []).flatMap((p) =>
        p.data.map((et) => ({ ...et, id: et.eventType }))
      ),
    [query.data]
  );

  const lastPage = query.data?.pages[query.data.pages.length - 1];

  return {
    data,
    hasMore: lastPage?.hasMore ?? query.hasNextPage ?? false,
    isLoading: query.isLoading,
    isReloading: query.isRefetching && data.length > 0,
    error: query.error,
    total: 0,
    onQueryChange,
    reload,
  };
};

export default useInfiniteEventTypes;
