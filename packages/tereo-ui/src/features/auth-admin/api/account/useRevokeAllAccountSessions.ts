import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

interface RevokeAllParams {
  includeCurrentSession: boolean;
}

interface RevokeAllResponse {
  revokedCount: number;
  currentSessionRevoked: boolean;
}

const useRevokeAllAccountSessions = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (params: RevokeAllParams): Promise<RevokeAllResponse> => {
      const res = await axios.delete("/v1/account/sessions", {
        data: params,
      });
      return res.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["account", "sessions"] });
      toast.success(`Revoked ${data.revokedCount} session(s)`);
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to revoke sessions"
      );
    },
  });
};

export default useRevokeAllAccountSessions;
