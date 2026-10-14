import type { ConnectedIdentity } from "../identity-providers/types";
import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

const useAccountIdentities = () => {
  const axios = useAxios("auth");

  return useQuery({
    queryKey: ["account", "identities"],
    queryFn: async (): Promise<ConnectedIdentity[]> => {
      const res = await axios.get("/v1/account/identities");
      return res.data;
    },
  });
};

export default useAccountIdentities;
