import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { User, UpdateUserInput } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useUpdateUser = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (data: {
    id: string;
    updateData: UpdateUserInput;
  }): Promise<User> => {
    const res = await axios.patch(
      `/v1/admin/users/${data.id}`,
      data.updateData
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["users", variables.id],
      });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.success("User updated successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to update user"
      );
    },
  });
};

export default useUpdateUser;
