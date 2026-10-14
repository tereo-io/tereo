import type { CursorPage, EventType } from "../types";
import { useQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";

/**
 * Every event type, following cursors to the end — for pickers. Event types
 * are declared by services, so the set is small. Includes retired ones; filter
 * on `retiredAt` for what can still be subscribed to.
 */
const useEventTypes = () => {
  const { hasPermission } = useAuth();
  const axios = useAxios("webhooks");

  const queryFn = async (): Promise<EventType[]> => {
    const all: EventType[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({
        limit: "200",
        sort: "eventType",
        sortDir: "asc",
      });
      if (cursor) params.set("cursor", cursor);
      const res = await axios.get<CursorPage<EventType>>(
        `/event-types?${params.toString()}`
      );
      all.push(...res.data.data);
      cursor = res.data.hasMore ? res.data.nextCursor : null;
    } while (cursor);
    return all;
  };

  return useQuery({
    queryKey: ["webhook-event-types", "all"],
    queryFn,
    enabled: hasPermission("webhooks.event-types.read"),
    staleTime: 60_000,
  });
};

export default useEventTypes;
