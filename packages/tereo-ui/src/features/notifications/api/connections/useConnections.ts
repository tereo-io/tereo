import type { NotificationConnection } from "../types";
import { useQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";

export const CONNECTIONS_KEY = ["notification-connections"];

/** `GET /v1/admin/notifications/connections` */
const useConnections = () => {
  const { hasPermission } = useAuth();
  const axios = useAxios("auth");

  const queryFn = async (): Promise<NotificationConnection[]> => {
    const res = await axios.get("/v1/admin/notifications/connections");
    return res.data.data;
  };

  return useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn,
    enabled: hasPermission("notifications.read"),
  });
};

export default useConnections;
