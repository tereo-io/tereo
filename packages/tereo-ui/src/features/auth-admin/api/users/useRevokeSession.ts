import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

interface RevokeSessionParams {
  userId: string;
  sessionId: string;
}

const useRevokeSession = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async ({
    userId,
    sessionId,
  }: RevokeSessionParams): Promise<void> => {
    await axios.delete(`/v1/admin/users/${userId}/sessions`, {
      data: { sessionId },
    });
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, { userId }) => {
      await queryClient.invalidateQueries({
        queryKey: ["users", userId, "sessions"],
      });
      toast.success("Session revoked successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to revoke session"
      );
    },
  });
};

export default useRevokeSession;
