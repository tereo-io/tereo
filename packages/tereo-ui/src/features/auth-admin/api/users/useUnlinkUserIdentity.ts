import { identityErrorMessage } from "../identity-providers/errors";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useUnlinkUserIdentity = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (data: { userId: string; identityId: string }) => {
      await axios.delete(
        `/v1/admin/users/${data.userId}/identities/${data.identityId}`
      );
    },
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["users", variables.userId, "identities"],
      });
      toast.success("Account disconnected");
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error, "Failed to disconnect"));
    },
  });
};

export default useUnlinkUserIdentity;
