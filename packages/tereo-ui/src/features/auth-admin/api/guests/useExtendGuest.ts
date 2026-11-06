import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UserDetail } from "../users/types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useExtendGuest = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (data: {
      id: string;
      expiresAt: string;
    }): Promise<UserDetail> => {
      const res = await axios.patch(`/v1/admin/guests/${data.id}`, {
        expiresAt: data.expiresAt,
      });
      return res.data;
    },
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["users", variables.id],
      });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.success("Guest access updated");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to update guest"
      );
    },
  });
};

export default useExtendGuest;
