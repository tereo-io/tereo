import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import type { Role } from "./types";
import { AxiosError } from "axios";

const useSetRolePermissions = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (data: {
    roleId: string;
    permissionIds: string[];
  }): Promise<Role> => {
    const res = await axios.put(`/v1/admin/roles/${data.roleId}/permissions`, {
      permissionIds: data.permissionIds,
    });
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["roles", variables.roleId],
      });
      await queryClient.invalidateQueries({ queryKey: ["roles"] });
      await queryClient.invalidateQueries({ queryKey: ["roles-infinite"] });
      await queryClient.invalidateQueries({ queryKey: ["allRoles"] });
      toast.success("Role permissions updated successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description ||
          "Failed to update role permissions"
      );
    },
  });
};

export default useSetRolePermissions;
