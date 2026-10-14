import type { OAuthClientWithSecret, CreateClientInput } from "./types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useCreateClient = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (
    data: CreateClientInput
  ): Promise<OAuthClientWithSecret> => {
    const res = await axios.post("/v1/admin/clients", data);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["clients"] });
      if (data.clientSecret) return;
      toast.success("Client created successfully");
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to create client"
      );
    },
  });
};

export default useCreateClient;
