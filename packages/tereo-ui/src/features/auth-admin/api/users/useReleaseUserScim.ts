import { identityErrorMessage } from "../identity-providers/errors";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

/** Ends an unlinked user's exclusion from SCIM; core needs a global admin. */
const useReleaseUserScim = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (userId: string) => {
      await axios.put(`/v1/admin/users/${userId}/scim/release`);
    },
    onSuccess: async (_, userId) => {
      await queryClient.invalidateQueries({ queryKey: ["users", userId] });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      await queryClient.invalidateQueries({
        queryKey: ["identity-providers"],
      });
      toast.success("SCIM allowed again for this user");
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error, "Failed to allow SCIM again"));
    },
  });
};

export default useReleaseUserScim;
