import { useQuery } from "@tanstack/react-query";
import type { ProviderDomain } from "./types";
import { useAxios } from "@/lib/auth";

const useProviderDomains = (providerId: string) => {
  const axios = useAxios("auth");

  return useQuery({
    queryKey: ["identity-providers", providerId, "domains"],
    queryFn: async (): Promise<ProviderDomain[]> => {
      const res = await axios.get(
        `/v1/admin/identity-providers/${providerId}/domains`
      );
      // A plain array, or a cursor page's rows.
      return Array.isArray(res.data) ? res.data : res.data.data;
    },
    enabled: !!providerId,
  });
};

export default useProviderDomains;
