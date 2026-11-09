import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorDescriptionOf } from "@/utils/apiErrors";
import { invalidateGroups } from "./invalidate";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useSetGroupRoles = (groupId: string) => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (roleIds: string[]): Promise<void> => {
    await axios.put(`/v1/admin/groups/${groupId}/roles`, { roleIds });
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await invalidateGroups(queryClient, groupId);
      toast.success("Group roles updated successfully");
    },
    onError: (error) => {
      toast.error(errorDescriptionOf(error, "Failed to update group roles"));
    },
  });
};

export default useSetGroupRoles;
