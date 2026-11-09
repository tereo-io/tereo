import { useQuery } from "@tanstack/react-query";
import type { GroupRole } from "./types";
import { useAxios } from "@/lib/auth";

const useGroupRoles = (groupId: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<GroupRole[]> => {
    const res = await axios.get(`/v1/admin/groups/${groupId}/roles`);
    return res.data.data;
  };

  return useQuery({
    queryKey: ["groups", groupId, "roles"],
    queryFn,
    enabled: !!groupId,
  });
};

export default useGroupRoles;
