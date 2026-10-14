import { useInfiniteCursor } from "@kosmeo-ui/react";
import type { ServiceListItem } from "./types";
import { useAxios } from "@/lib/auth";

const useInfiniteServices = () => {
  const axios = useAxios("auth");
  return useInfiniteCursor<ServiceListItem>({
    axiosInstance: axios,
    endpoint: "/v1/admin/services",
    queryKey: "services",
  });
};

export default useInfiniteServices;
