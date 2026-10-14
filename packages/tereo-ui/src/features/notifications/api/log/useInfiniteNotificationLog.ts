import type { NotificationLogFilters, NotificationLogListItem } from "../types";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";

export const LOG_KEY = "notification-log";

const PAGE_SIZE = 25;

interface LogPage {
  data: NotificationLogListItem[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

const queryString = (filters: NotificationLogFilters, cursor?: string) => {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (filters.channel) params.set("filter[channel]", filters.channel);
  if (filters.status) params.set("filter[status]", filters.status);
  if (filters.senderUserId)
    params.set("filter[senderUserId]", filters.senderUserId);
  if (filters.recipient) params.set("filter[recipient]", filters.recipient);
  if (filters.createdFrom)
    params.set("filter[createdAt_gte]", filters.createdFrom);
  if (filters.createdTo) params.set("filter[createdAt_lte]", filters.createdTo);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
};

/**
 * `GET /v1/admin/notifications` — newest first, cursor-paged
 * (`{ data, hasMore, limit, nextCursor }`). Core takes several filters by
 * equality only (a free-text search is a 400), so the log has its own filter
 * bar instead of the generic InfiniteScroll menu.
 */
const useInfiniteNotificationLog = (filters: NotificationLogFilters) => {
  const { hasPermission } = useAuth();
  const axios = useAxios("auth");

  return useInfiniteQuery<LogPage, Error>({
    queryKey: [LOG_KEY, "list", filters],
    enabled: hasPermission("notifications.read"),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) =>
      last.hasMore && last.nextCursor ? last.nextCursor : undefined,
    queryFn: async ({ pageParam }) => {
      const res = await axios.get<LogPage>(
        `/v1/admin/notifications?${queryString(filters, pageParam as string | undefined)}`
      );
      return res.data;
    },
  });
};

export default useInfiniteNotificationLog;
