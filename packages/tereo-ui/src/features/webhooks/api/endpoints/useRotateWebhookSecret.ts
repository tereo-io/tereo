import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import useWebhooksAxios from "../useWebhooksAxios";
import type { WebhookEndpoint } from "../types";
import { toast } from "react-toastify";

/**
 * `POST /webhooks/:id/rotate-secret` (`webhooks.admin`) — returns the
 * endpoint with its new, full signing secret. The old one keeps signing
 * until `previousSecretExpiresAt`.
 */
const useRotateWebhookSecret = () => {
  const queryClient = useQueryClient();
  const axios = useWebhooksAxios();

  const mutationFn = async (id: string): Promise<WebhookEndpoint> => {
    const res = await axios.post(`/webhooks/${id}/rotate-secret`);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, id) => {
      await queryClient.invalidateQueries({
        queryKey: ["webhook-endpoints", id],
      });
    },
    onError: (error: CoreError) => {
      toast.error(errorMessage(error, "Failed to rotate signing secret"));
    },
  });
};

export default useRotateWebhookSecret;
