import { useMutation, useQueryClient } from "@tanstack/react-query";
import { identityErrorMessage } from "./errors";
import type { NewScimToken } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useCreateScimToken = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    // The token is shown once; the mutation cache must not keep it.
    gcTime: 0,
    mutationFn: async (providerId: string): Promise<NewScimToken> => {
      const res = await axios.post(
        `/v1/admin/identity-providers/${providerId}/scim/tokens`
      );
      return res.data;
    },
    onSuccess: async (_, providerId) => {
      await queryClient.invalidateQueries({
        queryKey: ["identity-providers", providerId, "scim"],
      });
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error, "Failed to generate a token"));
    },
  });
};

export default useCreateScimToken;
