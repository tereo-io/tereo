import type { NotificationChannelInfo } from "../types";
import { useQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";

/** `GET /v1/admin/notifications/channels` — each channel's settings and secrets JSON Schema. */
const useChannels = () => {
  const { hasPermission } = useAuth();
  const axios = useAxios("auth");

  const queryFn = async (): Promise<NotificationChannelInfo[]> => {
    const res = await axios.get("/v1/admin/notifications/channels");
    return res.data.data;
  };

  return useQuery({
    queryKey: ["notification-channels"],
    queryFn,
    enabled: hasPermission("notifications.read"),
    staleTime: Infinity,
  });
};

export default useChannels;
