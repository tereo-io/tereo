import type { OAuthClient } from "../oauth-clients/types";
import { useQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";

interface DashboardPage {
  data: OAuthClient[];
  hasMore: boolean;
}

/**
 * Newest first, one page (core's cap) — the dashboard's count and recent
 * list. Core's cursor lists return no total.
 */
const useClients = () => {
  const axios = useAxios("auth");
  const { hasPermission } = useAuth();

  const queryFn = async (): Promise<DashboardPage> => {
    const res = await axios.get("/v1/admin/clients", {
      params: { limit: 200, sort: "createdAt", sortDir: "desc" },
    });
    return res.data;
  };

  return useQuery({
    queryKey: ["dashboard", "clients"],
    queryFn,
    enabled: hasPermission("clients.read"),
  });
};

export default useClients;
