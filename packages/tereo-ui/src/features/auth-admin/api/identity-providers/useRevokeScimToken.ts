import { useMutation, useQueryClient } from "@tanstack/react-query";
import { identityErrorMessage } from "./errors";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useRevokeScimToken = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (data: { providerId: string; tokenId: string }) => {
      await axios.delete(
        `/v1/admin/identity-providers/${data.providerId}/scim/tokens/${data.tokenId}`
      );
    },
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["identity-providers", variables.providerId, "scim"],
      });
      toast.success("Token revoked");
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error, "Failed to revoke the token"));
    },
  });
};

export default useRevokeScimToken;
