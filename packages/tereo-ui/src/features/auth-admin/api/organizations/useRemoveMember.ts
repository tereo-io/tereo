import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useRemoveMember = (orgId: string) => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (userId: string): Promise<void> => {
    await axios.delete(`/v1/admin/organizations/${orgId}/members/${userId}`);
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["organizations", orgId, "members"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["organizations", orgId],
      });
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      toast.success("Member removed successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to remove member"
      );
    },
  });
};

export default useRemoveMember;
