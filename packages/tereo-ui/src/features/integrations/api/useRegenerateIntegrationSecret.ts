import type { ApiErrorBody, RegeneratedIntegrationSecret } from "./types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import invalidateIntegrations from "./invalidateIntegrations";
import type { AxiosError } from "axios";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useRegenerateIntegrationSecret = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (
    id: string
  ): Promise<RegeneratedIntegrationSecret> => {
    const res = await axios.post(
      `/v1/admin/integrations/${id}/regenerate-secret`
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: () => invalidateIntegrations(queryClient),
    onError: (error: AxiosError<ApiErrorBody>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to regenerate secret"
      );
    },
  });
};

export default useRegenerateIntegrationSecret;
