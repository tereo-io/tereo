import { useQuery } from "@tanstack/react-query";
import type { UserRolesResponse } from "./types";
import { useAxios } from "@/lib/auth";

const useUserRoles = (userId: string) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<UserRolesResponse> => {
    const res = await axios.get(`/v1/admin/users/${userId}/roles`);
    return res.data;
  };

  return useQuery({
    queryKey: ["users", userId, "roles"],
    queryFn,
    enabled: !!userId,
  });
};

export default useUserRoles;
