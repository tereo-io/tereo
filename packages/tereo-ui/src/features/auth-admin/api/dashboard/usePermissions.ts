import type { Permission } from "../permissions/types";
import { useQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";

interface DashboardPage {
  data: Permission[];
  hasMore: boolean;
}

/**
 * Newest first, one page (core's cap) — the dashboard's count and recent
 * list. Core's cursor lists return no total.
 */
const usePermissions = () => {
  const axios = useAxios("auth");
  const { hasPermission } = useAuth();

  const queryFn = async (): Promise<DashboardPage> => {
    const res = await axios.get("/v1/admin/permissions", {
      params: { limit: 200, sort: "createdAt", sortDir: "desc" },
    });
    return res.data;
  };

  return useQuery({
    queryKey: ["dashboard", "permissions"],
    queryFn,
    enabled: hasPermission("permissions.read"),
  });
};

export default usePermissions;
