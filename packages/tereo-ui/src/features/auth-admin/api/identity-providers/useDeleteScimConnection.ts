import { useMutation, useQueryClient } from "@tanstack/react-query";
import { identityErrorMessage } from "./errors";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useDeleteScimConnection = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (providerId: string) => {
      await axios.delete(`/v1/admin/identity-providers/${providerId}/scim`);
    },
    onSuccess: async (_, providerId) => {
      await queryClient.invalidateQueries({
        queryKey: ["identity-providers", providerId, "scim"],
      });
      toast.success("SCIM removed");
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error, "Failed to remove SCIM"));
    },
  });
};

export default useDeleteScimConnection;
