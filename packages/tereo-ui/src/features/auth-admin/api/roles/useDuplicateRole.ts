import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Role, DuplicateRoleInput } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

/**
 * Copies a role (system or custom) into a new custom role with the same
 * unretired permissions — how an admin gets an editable variant of a
 * system role.
 */
const useDuplicateRole = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (data: {
    id: string;
    input: DuplicateRoleInput;
  }): Promise<Role> => {
    const res = await axios.post(
      `/v1/admin/roles/${data.id}/duplicate`,
      data.input
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["roles-infinite"] });
      await queryClient.invalidateQueries({ queryKey: ["allRoles"] });
      toast.success("Role duplicated successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to duplicate role"
      );
    },
  });
};

export default useDuplicateRole;
