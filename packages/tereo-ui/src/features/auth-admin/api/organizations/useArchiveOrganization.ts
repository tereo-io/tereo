import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useArchiveOrganization = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (id: string): Promise<void> => {
    await axios.post(`/v1/admin/organizations/${id}/archive`);
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
      toast.success("Organization archived successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description ||
          "Failed to archive organization"
      );
    },
  });
};

export default useArchiveOrganization;
