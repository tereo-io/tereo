import { useMutation, useQueryClient } from "@tanstack/react-query";
import { identityErrorMessage } from "./errors";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useSetProviderActive = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (data: { id: string; active: boolean }) => {
      await axios.post(
        `/v1/admin/identity-providers/${data.id}/${data.active ? "activate" : "deactivate"}`
      );
    },
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["identity-providers"] });
      toast.success(
        variables.active ? "Provider activated" : "Provider deactivated"
      );
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error, "Failed to change the provider"));
    },
  });
};

export default useSetProviderActive;
