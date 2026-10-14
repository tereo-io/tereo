import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useRestoreOrganization = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (id: string): Promise<void> => {
    await axios.post(`/v1/admin/organizations/${id}/restore`);
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_data, id) => {
      // The list is cached under the `-infinite` key; `["organizations"]` alone
      // would only prefix-match the single-item query, not the list.
      await queryClient.invalidateQueries({
        queryKey: ["organizations-infinite"],
      });
      await queryClient.invalidateQueries({ queryKey: ["organizations", id] });
      toast.success("Organization restored successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description ||
          "Failed to restore organization"
      );
    },
  });
};

export default useRestoreOrganization;
