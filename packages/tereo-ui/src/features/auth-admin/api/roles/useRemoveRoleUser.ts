import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

interface RemoveRoleUserParams {
  roleId: string;
  userId: string;
  /** Set to remove an org-scoped assignment rather than the global one. */
  organizationId?: string | null;
}

const useRemoveRoleUser = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async ({
    roleId,
    userId,
    organizationId,
  }: RemoveRoleUserParams): Promise<void> => {
    await axios.delete(`/v1/admin/roles/${roleId}/users/${userId}`, {
      params: organizationId ? { organizationId } : undefined,
    });
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, { roleId }) => {
      await queryClient.invalidateQueries({
        queryKey: ["roles", roleId, "users"],
      });
      toast.success("User removed from role successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description ||
          "Failed to remove user from role"
      );
    },
  });
};

export default useRemoveRoleUser;
