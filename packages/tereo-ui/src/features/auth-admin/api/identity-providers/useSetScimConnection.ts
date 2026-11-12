import { useMutation, useQueryClient } from "@tanstack/react-query";
import { identityErrorMessage } from "./errors";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useSetScimConnection = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (data: { providerId: string; isActive: boolean }) => {
      await axios.put(`/v1/admin/identity-providers/${data.providerId}/scim`, {
        isActive: data.isActive,
      });
    },
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["identity-providers", variables.providerId, "scim"],
      });
      toast.success(variables.isActive ? "SCIM enabled" : "SCIM disabled");
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error, "Failed to change SCIM"));
    },
  });
};

export default useSetScimConnection;
