import { useQuery } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";
import type { SetupStatus } from "./types";

export const SETUP_STATUS_KEY = ["setup", "status"];

/**
 * Whether core still needs its first admin. Public. Once setup is complete it
 * stays complete, so a `true` is never refetched.
 */
const useSetupStatus = () => {
  const axios = usePublicAxios("auth");

  return useQuery({
    queryKey: SETUP_STATUS_KEY,
    queryFn: async (): Promise<SetupStatus> => {
      const res = await axios.get("/v1/setup/status");
      return res.data;
    },
    staleTime: (query) =>
      query.state.data?.setupComplete ? Infinity : 30 * 1000,
  });
};

export default useSetupStatus;
