import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

interface ResetUserTotpResult {
  success: boolean;
  message: string;
}

const useResetUserTotp = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (userId: string): Promise<ResetUserTotpResult> => {
      const res = await axios.post(`/v1/admin/users/${userId}/totp/reset`);
      return res.data;
    },
    onSuccess: (_data, userId) => {
      queryClient.invalidateQueries({ queryKey: ["users", userId, "totp"] });
      queryClient.invalidateQueries({
        queryKey: ["users", userId, "sessions"],
      });
      toast.success("Two-factor authentication reset");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description ||
          "Failed to reset two-factor authentication"
      );
    },
  });
};

export default useResetUserTotp;
