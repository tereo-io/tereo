import type { IdentityProvider, UpdateIdentityProviderInput } from "./types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { identityErrorMessage } from "./errors";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useUpdateIdentityProvider = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (data: {
      id: string;
      updateData: UpdateIdentityProviderInput;
    }): Promise<IdentityProvider> => {
      const res = await axios.patch(
        `/v1/admin/identity-providers/${data.id}`,
        data.updateData
      );
      return res.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["identity-providers"] });
      toast.success("Identity provider updated");
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error, "Failed to update provider"));
    },
  });
};

export default useUpdateIdentityProvider;
