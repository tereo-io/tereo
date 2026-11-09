import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateGroupInput, Group } from "./types";
import { invalidateGroups } from "./invalidate";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useCreateGroup = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (data: CreateGroupInput): Promise<Group> => {
    const res = await axios.post("/v1/admin/groups", data);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await invalidateGroups(queryClient);
      toast.success("Group created successfully");
    },
  });
};

export default useCreateGroup;
