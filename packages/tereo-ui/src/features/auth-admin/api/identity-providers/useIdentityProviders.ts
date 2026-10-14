import { useQuery } from "@tanstack/react-query";
import type { IdentityProvider } from "./types";
import { useAxios } from "@/lib/auth";

const useIdentityProviders = () => {
  const axios = useAxios("auth");

  return useQuery({
    queryKey: ["identity-providers"],
    queryFn: async (): Promise<IdentityProvider[]> => {
      const res = await axios.get("/v1/admin/identity-providers");
      // A plain array, or a cursor page's rows.
      return Array.isArray(res.data) ? res.data : res.data.data;
    },
  });
};

export default useIdentityProviders;
