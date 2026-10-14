import type { OAuthClientWithSecret, UpdateClientInput } from "./types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useUpdateClient = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (data: {
    id: string;
    updateData: UpdateClientInput;
  }): Promise<OAuthClientWithSecret> => {
    const res = await axios.patch(
      `/v1/admin/clients/${data.id}`,
      data.updateData
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["clients", variables.id],
      });
      await queryClient.invalidateQueries({ queryKey: ["clients"] });
      toast.success("Client updated successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to update client"
      );
    },
  });
};

export default useUpdateClient;
