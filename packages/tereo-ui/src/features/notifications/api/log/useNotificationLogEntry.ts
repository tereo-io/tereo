import { LOG_KEY } from "./useInfiniteNotificationLog";
import type { NotificationLogDetail } from "../types";
import { useQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";

/** `GET /v1/admin/notifications/:id` — `content` is null once every delivery is sent. */
const useNotificationLogEntry = (id: string | null) => {
  const { hasPermission } = useAuth();
  const axios = useAxios("auth");

  const queryFn = async (): Promise<NotificationLogDetail> => {
    const res = await axios.get(`/v1/admin/notifications/${id}`);
    return res.data;
  };

  return useQuery({
    queryKey: [LOG_KEY, "detail", id],
    queryFn,
    enabled: !!id && hasPermission("notifications.read"),
  });
};

export default useNotificationLogEntry;
