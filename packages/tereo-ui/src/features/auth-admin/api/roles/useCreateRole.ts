import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Role, CreateRoleInput } from "./types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

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
  });
};

export default useCreateRole;
