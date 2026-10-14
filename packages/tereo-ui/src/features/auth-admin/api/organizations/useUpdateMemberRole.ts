import type { OrganizationMember, UpdateMemberRoleInput } from "./types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useUpdateMemberRole = (orgId: string) => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (data: {
    userId: string;
    updateData: UpdateMemberRoleInput;
  }): Promise<OrganizationMember> => {
    const res = await axios.patch(
      `/v1/admin/organizations/${orgId}/members/${data.userId}`,
      data.updateData
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["organizations", orgId, "members"],
      });
      toast.success("Member role updated successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description ||
          "Failed to update member role"
      );
    },
  });
};

export default useUpdateMemberRole;
