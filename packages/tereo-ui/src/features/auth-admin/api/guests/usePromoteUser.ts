import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UserDetail } from "../users/types";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const usePromoteUser = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  return useMutation({
    mutationFn: async (id: string): Promise<UserDetail> => {
      const res = await axios.post(`/v1/admin/users/${id}/promote`);
      return res.data;
    },
    onSuccess: async (_data, id) => {
      await queryClient.invalidateQueries({ queryKey: ["users", id] });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.success("Guest promoted to a full user");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to promote guest"
      );
    },
  });
};

export default usePromoteUser;
