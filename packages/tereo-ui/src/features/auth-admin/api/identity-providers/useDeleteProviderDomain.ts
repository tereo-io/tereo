import { useMutation, useQueryClient } from "@tanstack/react-query";
import { identityErrorMessage } from "./errors";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useDeleteProviderDomain = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (data: { providerId: string; domainId: string }) => {
      await axios.delete(
        `/v1/admin/identity-providers/${data.providerId}/domains/${data.domainId}`
      );
    },
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["identity-providers", variables.providerId, "domains"],
      });
      toast.success("Domain removed");
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error, "Failed to remove the domain"));
    },
  });
};

export default useDeleteProviderDomain;
