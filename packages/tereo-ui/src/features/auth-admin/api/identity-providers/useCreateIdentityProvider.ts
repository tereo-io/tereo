import type { IdentityProvider, CreateIdentityProviderInput } from "./types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { identityErrorMessage } from "./errors";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useCreateIdentityProvider = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (
      data: CreateIdentityProviderInput
    ): Promise<IdentityProvider> => {
      const res = await axios.post("/v1/admin/identity-providers", data);
      return res.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["identity-providers"] });
      toast.success("Identity provider created");
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error, "Failed to create provider"));
    },
  });
};

export default useCreateIdentityProvider;
