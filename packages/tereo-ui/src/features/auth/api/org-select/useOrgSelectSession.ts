import { useQuery } from "@tanstack/react-query";
import type { OrgSelectSession } from "./types";
import { usePublicAxios } from "@/lib/auth";

const useOrgSelectSession = (sessionToken: string | null) => {
  const axios = usePublicAxios("auth");
  return useQuery({
    queryKey: ["org-select", sessionToken],
    queryFn: async (): Promise<OrgSelectSession> => {
      const res = await axios.get(`/oauth/org-select`, {
        params: { session: sessionToken },
        withCredentials: true,
      });
      return res.data;
    },
    enabled: !!sessionToken,
  });
};

export default useOrgSelectSession;
