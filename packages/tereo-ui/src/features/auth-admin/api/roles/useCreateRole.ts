import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Role, CreateRoleInput } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useCreateRole = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (data: CreateRoleInput): Promise<Role> => {
    const res = await axios.post("/v1/admin/roles", data);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["roles"] });
      await queryClient.invalidateQueries({ queryKey: ["roles-infinite"] });
      await queryClient.invalidateQueries({ queryKey: ["allRoles"] });
      toast.success("Role created successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to create role"
      );
    },
  });
};

export default useCreateRole;
