import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Group, UpdateGroupInput } from "./types";
import { invalidateGroups } from "./invalidate";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useUpdateGroup = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (data: {
    id: string;
    updateData: UpdateGroupInput;
  }): Promise<Group> => {
    const res = await axios.patch(
      `/v1/admin/groups/${data.id}`,
      data.updateData
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, { id }) => {
      await invalidateGroups(queryClient, id);
      toast.success("Group updated successfully");
    },
  });
};

export default useUpdateGroup;
