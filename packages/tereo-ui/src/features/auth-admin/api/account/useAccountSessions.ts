import { AccountSessionsResponse } from "./types";
import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

const useAccountSessions = () => {
  const axios = useAxios("auth");

  return useQuery({
    queryKey: ["account", "sessions"],
    queryFn: async (): Promise<AccountSessionsResponse> => {
      const res = await axios.get("/v1/account/sessions");
      return res.data;
    },
  });
};

export default useAccountSessions;
