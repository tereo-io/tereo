import useFlagLiftingAxios from "../shared/useFlagLiftingAxios";
import { useInfiniteCursor } from "@kosmeo-ui/react";
import type { Permission } from "./types";
import { useAuth } from "@/lib/auth";

const useInfinitePermissions = () => {
  const { hasPermission } = useAuth();
  const axios = useFlagLiftingAxios("includeRetired");

  return useInfiniteCursor<Permission>({
    axiosInstance: axios,
    endpoint: `/v1/admin/permissions`,
    queryKey: "permissions",
    enabled: hasPermission("permissions.read"),
  });
};

export default useInfinitePermissions;
