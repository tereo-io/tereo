import fetchAllPages from "@/utils/fetchAllPages";
import { useQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";
import type { ServiceSummary } from "./types";

/**
 * Every registered service (core included), to label the permissions and
 * system roles each one declares. Needs `services.read`; without it callers
 * fall back to showing the raw service id.
 */
const useServices = () => {
  const { hasPermission } = useAuth();
  const axios = useAxios("auth");

  return useQuery({
    queryKey: ["services", "all"],
    queryFn: () =>
      fetchAllPages<ServiceSummary>(axios, "/v1/admin/services", {
        sort: "name",
        sortDir: "asc",
      }),
    enabled: hasPermission("services.read"),
    staleTime: 5 * 60 * 1000,
  });
};

export default useServices;
