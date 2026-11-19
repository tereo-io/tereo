import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UserReportsTo } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useSetReportsTo = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (data: {
      id: string;
      managerId: string;
      previousManagerId?: string | null;
    }): Promise<UserReportsTo> => {
      const res = await axios.put(`/v1/admin/users/${data.id}/reports-to`, {
        userId: data.managerId,
      });
      return res.data;
    },
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["users", variables.id],
      });
      await queryClient.invalidateQueries({
        queryKey: ["users", variables.managerId, "reports"],
      });
      if (variables.previousManagerId) {
        await queryClient.invalidateQueries({
          queryKey: ["users", variables.previousManagerId, "reports"],
        });
      }
      toast.success("Reporting line updated");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description ||
          "Failed to update the reporting line"
      );
    },
  });
};

export default useSetReportsTo;
