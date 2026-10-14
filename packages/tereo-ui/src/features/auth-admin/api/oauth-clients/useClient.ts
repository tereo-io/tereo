import { useQuery } from "@tanstack/react-query";
import type { OAuthClient } from "./types";
import { useAxios } from "@/lib/auth";

const useClient = (id: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<OAuthClient> => {
    const res = await axios.get(`/v1/admin/clients/${id}`);
    return res.data;
  };

  return useQuery({
    queryKey: ["clients", id],
    queryFn,
    enabled: !!id,
  });
};

export default useClient;
