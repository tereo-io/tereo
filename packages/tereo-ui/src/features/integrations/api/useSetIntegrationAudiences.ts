import { useMutation, useQueryClient } from "@tanstack/react-query";
import invalidateIntegrations from "./invalidateIntegrations";
import type { ApiErrorBody, Integration } from "./types";
import type { AxiosError } from "axios";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

interface Variables {
  id: string;
  slugs: string[];
}

const useSetIntegrationAudiences = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async ({ id, slugs }: Variables): Promise<Integration> => {
    const res = await axios.put(`/v1/admin/integrations/${id}/audiences`, {
      slugs,
    });
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: () => invalidateIntegrations(queryClient),
    onError: (error: AxiosError<ApiErrorBody>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to save audiences"
      );
    },
  });
};

export default useSetIntegrationAudiences;
