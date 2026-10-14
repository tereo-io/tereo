import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useArchiveRole = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (id: string): Promise<void> => {
    await axios.post(`/v1/admin/roles/${id}/archive`);
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_data, id) => {
      // The list is cached under the `-infinite` key; `["roles"]` alone would
      // only prefix-match the single-item query, not the list.
      await queryClient.invalidateQueries({ queryKey: ["roles-infinite"] });
      await queryClient.invalidateQueries({ queryKey: ["roles", id] });
      toast.success("Role archived successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to archive role"
      );
    },
  });
};

export default useArchiveRole;
