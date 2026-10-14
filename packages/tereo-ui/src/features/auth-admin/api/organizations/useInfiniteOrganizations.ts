import { useInfiniteArchivableCursor } from "@kosmeo-ui/react";
import { useAuth, useAxios } from "@/lib/auth";
import type { Organization } from "./types";

const useInfiniteOrganizations = () => {
  const { hasPermission } = useAuth();
  const axios = useAxios("auth");

  return useInfiniteArchivableCursor<Organization>({
    axiosInstance: axios,
    endpoint: `/v1/admin/organizations`,
    queryKey: "organizations",
    enabled: hasPermission("organizations.read"),
  });
};

export default useInfiniteOrganizations;
