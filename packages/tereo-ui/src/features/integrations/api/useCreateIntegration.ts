import { useMutation, useQueryClient } from "@tanstack/react-query";
import invalidateIntegrations from "./invalidateIntegrations";
import type { AxiosError } from "axios";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import type {
  ApiErrorBody,
  CreatedIntegration,
  CreateIntegrationInput,
} from "./types";

const useCreateIntegration = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (
    data: CreateIntegrationInput
  ): Promise<CreatedIntegration> => {
    const res = await axios.post("/v1/admin/integrations", data);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: () => invalidateIntegrations(queryClient),
    onError: (error: AxiosError<ApiErrorBody>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to add integration"
      );
    },
  });
};

export default useCreateIntegration;
