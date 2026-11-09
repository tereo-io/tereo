import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorDescriptionOf } from "@/utils/apiErrors";
import { invalidateGroups } from "./invalidate";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useRestoreGroup = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (id: string): Promise<void> => {
    await axios.post(`/v1/admin/groups/${id}/restore`);
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_data, id) => {
      await invalidateGroups(queryClient, id);
      toast.success("Group restored successfully");
    },
    onError: (error) => {
      toast.error(errorDescriptionOf(error, "Failed to restore group"));
    },
  });
};

export default useRestoreGroup;
