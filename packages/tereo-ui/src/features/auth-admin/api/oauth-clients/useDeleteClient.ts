import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useDeleteClient = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (id: string): Promise<void> => {
    await axios.delete(`/v1/admin/clients/${id}`);
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, id) => {
      queryClient.removeQueries({ queryKey: ["clients", id] });
      await queryClient.invalidateQueries({ queryKey: ["clients-infinite"] });
      await queryClient.invalidateQueries({
        queryKey: ["dashboard", "clients"],
      });
      toast.success("Client deleted successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to delete client"
      );
    },
  });
};

export default useDeleteClient;
