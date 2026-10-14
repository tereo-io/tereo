import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OrganizationMember, AddMemberInput } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useAddMember = (orgId: string) => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (
    data: AddMemberInput
  ): Promise<OrganizationMember> => {
    const res = await axios.post(
      `/v1/admin/organizations/${orgId}/members`,
      data
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["organizations", orgId, "members"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["organizations", orgId],
      });
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      toast.success("Member added successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to add member"
      );
    },
  });
};

export default useAddMember;
