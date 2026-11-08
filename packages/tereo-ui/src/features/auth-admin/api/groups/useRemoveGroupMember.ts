import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorDescriptionOf } from "@/utils/apiErrors";
import { invalidateGroups } from "./invalidate";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useRemoveGroupMember = (groupId: string) => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (userId: string): Promise<void> => {
    await axios.delete(`/v1/admin/groups/${groupId}/members/${userId}`);
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await invalidateGroups(queryClient, groupId);
      toast.success("Member removed");
    },
    onError: (error) => {
      toast.error(errorDescriptionOf(error, "Failed to remove member"));
    },
  });
};

export default useRemoveGroupMember;
