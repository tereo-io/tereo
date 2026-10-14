import { useQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";
import type { User } from "../users/types";

interface DashboardPage {
  data: User[];
  hasMore: boolean;
}

/**
 * Newest first, one page (core's cap) — the dashboard's count and recent
 * list. Core's cursor lists return no total.
 */
const useUsers = () => {
  const axios = useAxios("auth");
  const { hasPermission } = useAuth();

  const queryFn = async (): Promise<DashboardPage> => {
    const res = await axios.get("/v1/admin/users", {
      params: { limit: 200, sort: "createdAt", sortDir: "desc" },
    });
    return res.data;
  };

  return useQuery({
    queryKey: ["dashboard", "users"],
    queryFn,
    enabled: hasPermission("users.read"),
  });
};

export default useUsers;
