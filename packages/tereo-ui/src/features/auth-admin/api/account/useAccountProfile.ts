import { useQuery } from "@tanstack/react-query";
import { AccountProfile } from "./types";
import { useAxios } from "@/lib/auth";

const useAccountProfile = () => {
  const axios = useAxios("auth");

  return useQuery({
    queryKey: ["account", "profile"],
    queryFn: async (): Promise<AccountProfile> => {
      const res = await axios.get("/v1/account/me");
      return res.data;
    },
  });
};

export default useAccountProfile;
