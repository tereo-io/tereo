import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import useWebhooksAxios from "../useWebhooksAxios";
import type { WebhookEndpoint } from "../types";
import { toast } from "react-toastify";

/**
 * `POST /webhooks/:id/revoke-previous-secret` (`webhooks.admin`) — the
 * secret replaced by the last rotation stops signing deliveries now.
 */
const useRevokePreviousWebhookSecret = () => {
  const queryClient = useQueryClient();
  const axios = useWebhooksAxios();

  const mutationFn = async (id: string): Promise<WebhookEndpoint> => {
    const res = await axios.post(`/webhooks/${id}/revoke-previous-secret`);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, id) => {
      await queryClient.invalidateQueries({
        queryKey: ["webhook-endpoints", id],
      });
      toast.success("Previous signing secret revoked");
    },
    onError: (error: CoreError) => {
      toast.error(errorMessage(error, "Failed to revoke previous secret"));
    },
  });
};

export default useRevokePreviousWebhookSecret;
