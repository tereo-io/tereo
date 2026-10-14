import { useQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";
import type { Role } from "../roles/types";

interface DashboardPage {
  data: Role[];
  hasMore: boolean;
}

/**
 * Newest first, one page (core's cap) — the dashboard's count and recent
 * list. Core's cursor lists return no total.
 */
const useRoles = () => {
  const axios = useAxios("auth");
  const { hasPermission } = useAuth();

  const queryFn = async (): Promise<DashboardPage> => {
    const res = await axios.get("/v1/admin/roles", {
      params: { limit: 200, sort: "createdAt", sortDir: "desc" },
    });
    return res.data;
  };

  return useQuery({
    queryKey: ["dashboard", "roles"],
    queryFn,
    enabled: hasPermission("roles.read"),
  });
};

export default useRoles;
