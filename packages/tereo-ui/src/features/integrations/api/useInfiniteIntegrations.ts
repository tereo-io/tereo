import { useInfiniteCursor } from "@kosmeo-ui/react";
import type { Integration } from "./types";
import { useAxios } from "@/lib/auth";

const useInfiniteIntegrations = () => {
  const axios = useAxios("auth");
  return useInfiniteCursor<Integration>({
    axiosInstance: axios,
    endpoint: "/v1/admin/integrations",
    queryKey: "integrations",
  });
};

export default useInfiniteIntegrations;
