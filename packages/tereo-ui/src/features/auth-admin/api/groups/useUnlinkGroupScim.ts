import { identityErrorMessage } from "../identity-providers/errors";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidateGroups } from "./invalidate";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useUnlinkGroupScim = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (groupId: string) => {
      await axios.delete(`/v1/admin/groups/${groupId}/scim`);
    },
    onSuccess: async (_, groupId) => {
      await invalidateGroups(queryClient, groupId);
      await queryClient.invalidateQueries({
        queryKey: ["identity-providers"],
      });
      toast.success("Group unlinked from SCIM");
    },
    onError: (error) => {
      toast.error(identityErrorMessage(error, "Failed to unlink the group"));
    },
  });
};

export default useUnlinkGroupScim;
