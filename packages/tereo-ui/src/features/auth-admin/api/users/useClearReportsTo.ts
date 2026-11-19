import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useClearReportsTo = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (data: {
      id: string;
      previousManagerId?: string | null;
    }) => {
      await axios.delete(`/v1/admin/users/${data.id}/reports-to`);
    },
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["users", variables.id],
      });
      if (variables.previousManagerId) {
        await queryClient.invalidateQueries({
          queryKey: ["users", variables.previousManagerId],
        });
      }
      toast.success("Reporting line removed");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description ||
          "Failed to remove the reporting line"
      );
    },
  });
};

export default useClearReportsTo;
