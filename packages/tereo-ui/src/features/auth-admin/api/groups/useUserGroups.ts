import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";
import type { Group } from "./types";

const useUserGroups = (userId: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<Group[]> => {
    const res = await axios.get(`/v1/admin/users/${userId}/groups`);
    return res.data.data;
  };

  return useQuery({
    queryKey: ["users", userId, "groups"],
    queryFn,
    enabled: !!userId,
  });
};

export default useUserGroups;
