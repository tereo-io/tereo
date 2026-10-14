import type { MemberOrgRolesResponse } from "./types";
import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

const useMemberOrgRoles = (orgId: string, userId: string, enabled = true) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<MemberOrgRolesResponse> => {
    const res = await axios.get(
      `/v1/admin/organizations/${orgId}/members/${userId}/roles`
    );
    return res.data;
  };

  return useQuery({
    queryKey: ["organizations", orgId, "members", userId, "roles"],
    queryFn,
    enabled: enabled && !!orgId && !!userId,
  });
};

export default useMemberOrgRoles;
