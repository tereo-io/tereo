import { useMutation, useQueryClient } from "@tanstack/react-query";
import invalidateIntegrations from "./invalidateIntegrations";
import type { AxiosError } from "axios";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import type {
  ApiErrorBody,
  Integration,
  UpdateIntegrationInput,
} from "./types";

interface Variables {
  id: string;
  data: UpdateIntegrationInput;
}

const useUpdateIntegration = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async ({ id, data }: Variables): Promise<Integration> => {
    const res = await axios.patch(`/v1/admin/integrations/${id}`, data);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: () => invalidateIntegrations(queryClient),
    onError: (error: AxiosError<ApiErrorBody>) => {
      toast.error(
        error.response?.data?.error_description ||
          "Failed to update integration"
      );
    },
  });
};

export default useUpdateIntegration;
