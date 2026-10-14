import { useQuery } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";

export interface UpstreamProvider {
  slug: string;
  displayName: string;
}

/** The active identity providers a user can sign in with. */
const useUpstreamProviders = () => {
  const axios = usePublicAxios("auth");

  return useQuery({
    queryKey: ["upstream-providers"],
    queryFn: async (): Promise<UpstreamProvider[]> => {
      const res = await axios.get<UpstreamProvider[]>(
        "/oauth/upstream/providers"
      );
      return res.data;
    },
    staleTime: 60_000,
  });
};

export default useUpstreamProviders;
