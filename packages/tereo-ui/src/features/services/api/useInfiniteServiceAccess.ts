import { useInfiniteCursor } from "@kosmeo-ui/react";
import type { ServiceAccessListItem } from "./types";
import { useAxios } from "@/lib/auth";

const useInfiniteServiceAccess = () => {
  const axios = useAxios("auth");
  return useInfiniteCursor<ServiceAccessListItem>({
    axiosInstance: axios,
    endpoint: "/v1/admin/services/access",
    queryKey: "service-access",
  });
};

export default useInfiniteServiceAccess;
