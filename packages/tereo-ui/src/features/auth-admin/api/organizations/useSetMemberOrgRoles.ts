import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MemberOrgRolesResponse } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

/**
 * Replaces a member's roles within one organization. Core accepts custom
 * roles only — system roles are platform-wide and assigned under Users.
 */
const useSetMemberOrgRoles = (orgId: string) => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (data: {
    userId: string;
    roleIds: string[];
  }): Promise<MemberOrgRolesResponse> => {
    const res = await axios.put(
      `/v1/admin/organizations/${orgId}/members/${data.userId}/roles`,
      { roleIds: data.roleIds }
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, { userId }) => {
      await queryClient.invalidateQueries({
        queryKey: ["organizations", orgId, "members", userId, "roles"],
      });
      toast.success("Member roles updated successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description ||
          "Failed to update member roles"
      );
    },
  });
};

export default useSetMemberOrgRoles;
