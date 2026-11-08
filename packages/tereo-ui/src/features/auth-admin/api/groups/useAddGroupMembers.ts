import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorDescriptionOf } from "@/utils/apiErrors";
import { invalidateGroups } from "./invalidate";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useAddGroupMembers = (groupId: string) => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (
    userIds: string[]
  ): Promise<{ added: string[] }> => {
    const res = await axios.post(`/v1/admin/groups/${groupId}/members`, {
      userIds,
    });
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async ({ added }) => {
      await invalidateGroups(queryClient, groupId);
      toast.success(
        added.length === 1 ? "Member added" : `${added.length} members added`
      );
    },
    onError: (error) => {
      toast.error(errorDescriptionOf(error, "Failed to add members"));
    },
  });
};

export default useAddGroupMembers;
