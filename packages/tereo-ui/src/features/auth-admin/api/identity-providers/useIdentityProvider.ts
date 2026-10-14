import { useQuery } from "@tanstack/react-query";
import type { IdentityProvider } from "./types";
import { useAxios } from "@/lib/auth";

const useIdentityProvider = (id: string) => {
  const axios = useAxios("auth");

  return useQuery({
    queryKey: ["identity-providers", id],
    queryFn: async (): Promise<IdentityProvider> => {
      const res = await axios.get(`/v1/admin/identity-providers/${id}`);
      return res.data;
    },
    enabled: !!id,
  });
};

export default useIdentityProvider;
