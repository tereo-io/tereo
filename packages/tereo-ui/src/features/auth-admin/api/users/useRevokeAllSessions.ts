import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

interface RevokeAllSessionsParams {
  userId: string;
  includeCurrentSession?: boolean;
}

interface RevokeAllSessionsResponse {
  revokedCount: number;
  currentSessionRevoked: boolean;
}

const useRevokeAllSessions = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async ({
    userId,
    includeCurrentSession = false,
  }: RevokeAllSessionsParams): Promise<RevokeAllSessionsResponse> => {
    const res = await axios.delete(`/v1/admin/users/${userId}/sessions/all`, {
      data: { includeCurrentSession },
    });
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async (data, { userId }) => {
      await queryClient.invalidateQueries({
        queryKey: ["users", userId, "sessions"],
      });
      toast.success(`Revoked ${data.revokedCount} session(s)`);
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to revoke sessions"
      );
    },
  });
};

export default useRevokeAllSessions;
