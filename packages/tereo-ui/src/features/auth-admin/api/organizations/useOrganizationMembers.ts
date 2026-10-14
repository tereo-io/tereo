import type { OrganizationMembersResponse } from "./types";
import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

const useOrganizationMembers = (orgId: string, enabled = true) => {
  const axios = useAxios("auth");

  const queryFn = async (): Promise<OrganizationMembersResponse> => {
    const res = await axios.get(`/v1/admin/organizations/${orgId}/members`);
    return res.data;
  };

  return useQuery({
    queryKey: ["organizations", orgId, "members"],
    queryFn,
    enabled: !!orgId && enabled,
  });
};

export default useOrganizationMembers;
