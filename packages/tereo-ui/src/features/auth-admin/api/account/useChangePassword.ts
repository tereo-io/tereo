import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

interface ChangePasswordParams {
  currentPassword: string;
  newPassword: string;
}

interface ChangePasswordResponse {
  success: boolean;
  message: string;
}

const useChangePassword = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (
      params: ChangePasswordParams
    ): Promise<ChangePasswordResponse> => {
      const res = await axios.post("/v1/account/password", params);
      return res.data;
    },
    onSuccess: () => {
      // Core ends every other session of the user.
      queryClient.invalidateQueries({ queryKey: ["account", "sessions"] });
      toast.success("Password changed successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to change password"
      );
    },
  });
};

export default useChangePassword;
