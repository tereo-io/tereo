import useFlagLiftingAxios from "../shared/useFlagLiftingAxios";
import { useInfiniteArchivableCursor } from "@kosmeo-ui/react";
import { useAuth } from "@/lib/auth";
import type { Role } from "./types";

const useInfiniteRoles = () => {
  const { hasPermission } = useAuth();
  const axios = useFlagLiftingAxios("includeRetired");

  return useInfiniteArchivableCursor<Role>({
    axiosInstance: axios,
    endpoint: `/v1/admin/roles`,
    queryKey: "roles",
    enabled: hasPermission("roles.read"),
  });
};

export default useInfiniteRoles;
