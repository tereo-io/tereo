import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorDescriptionOf } from "@/utils/apiErrors";
import { invalidateGroups } from "./invalidate";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useArchiveGroup = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (id: string): Promise<void> => {
    await axios.post(`/v1/admin/groups/${id}/archive`);
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_data, id) => {
      await invalidateGroups(queryClient, id);
      toast.success("Group archived successfully");
    },
    onError: (error) => {
      toast.error(errorDescriptionOf(error, "Failed to archive group"));
    },
  });
};

export default useArchiveGroup;
