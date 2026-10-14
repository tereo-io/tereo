import { useInfiniteCursor } from "@kosmeo-ui/react";
import { OAuthClient } from "./types";
import { useAxios } from "@/lib/auth";

const useInfiniteClients = () => {
  const axios = useAxios("auth");
  return useInfiniteCursor<OAuthClient>({
    axiosInstance: axios,
    endpoint: "/v1/admin/clients",
    queryKey: "clients",
  });
};

export default useInfiniteClients;
