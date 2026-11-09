import { useQuery } from "@tanstack/react-query";
import type { RoleUsersResponse } from "./types";
import { useAxios } from "@/lib/auth";

const useRoleUsers = (roleId: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<RoleUsersResponse> => {
    const res = await axios.get(`/v1/admin/roles/${roleId}/users`);
    return res.data;
  };

  return useQuery({
    queryKey: ["roles", roleId, "users"],
    queryFn,
    enabled: !!roleId,
  });
};

export default useRoleUsers;
