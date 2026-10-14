import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { User, CreateUserInput } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useCreateUser = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (data: CreateUserInput): Promise<User> => {
    const res = await axios.post("/v1/admin/users", data);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.success("User created successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to create user"
      );
    },
  });
};

export default useCreateUser;
