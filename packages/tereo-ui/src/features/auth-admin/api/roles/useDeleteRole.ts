import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useDeleteRole = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (id: string): Promise<void> => {
    await axios.delete(`/v1/admin/roles/${id}`);
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_data, id) => {
      // Removed, not invalidated: refetching the deleted role would 404.
      queryClient.removeQueries({ queryKey: ["roles", id] });
      await queryClient.invalidateQueries({ queryKey: ["roles-infinite"] });
      await queryClient.invalidateQueries({ queryKey: ["allRoles"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard", "roles"] });
      // Assignments cascade away with the role.
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.success("Role deleted successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to delete role"
      );
    },
  });
};

export default useDeleteRole;
