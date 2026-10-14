import type { UserIdentities } from "../identity-providers/types";
import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

const useUserIdentities = (userId: string, enabled = true) => {
  const axios = useAxios("auth");

  return useQuery({
    queryKey: ["users", userId, "identities"],
    queryFn: async (): Promise<UserIdentities> => {
      const res = await axios.get(`/v1/admin/users/${userId}/identities`);
      return res.data;
    },
    enabled: !!userId && enabled,
  });
};

export default useUserIdentities;
