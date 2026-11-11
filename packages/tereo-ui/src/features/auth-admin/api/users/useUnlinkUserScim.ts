import { identityErrorMessage } from "../identity-providers/errors";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useUnlinkUserScim = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (userId: string) => {
      await axios.delete(`/v1/admin/users/${userId}/scim`);
    },
    onSuccess: async (_, userId) => {
      await queryClient.invalidateQueries({ queryKey: ["users", userId] });
      await queryClient.invalidateQueries({
        queryKey: ["identity-providers"],
      });
      toast.success("User unlinked from SCIM");
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error, "Failed to unlink the user"));
    },
  });
};

export default useUnlinkUserScim;
