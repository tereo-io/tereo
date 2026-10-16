import { useMutation, useQueryClient } from "@tanstack/react-query";
import invalidateIntegrations from "./invalidateIntegrations";
import type { ApiErrorBody, Integration } from "./types";
import type { AxiosError } from "axios";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";

const useRevokePreviousIntegrationSecret = () => {
  const queryClient = useQueryClient();
  const axios = useAxios("auth");

  const mutationFn = async (id: string): Promise<Integration> => {
    const res = await axios.post(
      `/v1/admin/integrations/${id}/revoke-previous-secret`
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await invalidateIntegrations(queryClient);
      toast.success("Previous secret revoked");
    },
    onError: (error: AxiosError<ApiErrorBody>) => {
      toast.error(
        error.response?.data?.error_description ||
          "Failed to revoke the previous secret"
      );
    },
  });
};

export default useRevokePreviousIntegrationSecret;
