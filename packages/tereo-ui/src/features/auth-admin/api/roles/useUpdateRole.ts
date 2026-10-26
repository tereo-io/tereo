import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Role, UpdateRoleInput } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useUpdateRole = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (data: {
    id: string;
    updateData: UpdateRoleInput;
  }): Promise<Role> => {
    const res = await axios.patch(
      `/v1/admin/roles/${data.id}`,
      data.updateData
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["roles", variables.id],
      });
      await queryClient.invalidateQueries({ queryKey: ["roles"] });
      await queryClient.invalidateQueries({ queryKey: ["roles-infinite"] });
      await queryClient.invalidateQueries({ queryKey: ["allRoles"] });
      toast.success("Role updated successfully");
    },
  });
};

export default useUpdateRole;
