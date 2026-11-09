import { useQuery } from "@tanstack/react-query";
import type { UserGroup } from "./types";
import { useAxios } from "@/lib/auth";

const useUserGroups = (userId: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<UserGroup[]> => {
    // Archived groups too: their roles come back on restore.
    const res = await axios.get(`/v1/admin/users/${userId}/groups`, {
      params: { includeArchived: true },
    });
    return res.data.data;
  };

  return useQuery({
    queryKey: ["users", userId, "groups"],
    queryFn,
    enabled: !!userId,
  });
};

export default useUserGroups;
