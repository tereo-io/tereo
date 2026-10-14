import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UserRole } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useSetUserRoles = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (data: {
    userId: string;
    roleIds: string[];
  }): Promise<{ userId: string; roles: UserRole[] }> => {
    const res = await axios.put(`/v1/admin/users/${data.userId}/roles`, {
      roleIds: data.roleIds,
    });
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["users", variables.userId, "roles"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["users", variables.userId, "permissions"],
      });
      toast.success("User roles updated successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to update user roles"
      );
    },
  });
};

export default useSetUserRoles;
