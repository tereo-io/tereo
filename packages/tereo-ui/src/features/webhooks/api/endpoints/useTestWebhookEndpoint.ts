import { deliveriesListKey } from "../deliveries/useInfiniteDeliveries";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import useWebhooksAxios from "../useWebhooksAxios";
import { toast } from "react-toastify";

/**
 * `POST /webhooks/:id/test` — queues a `webhook.test` delivery to an
 * ACTIVE, unarchived endpoint. Returns `202 { deliveryId }`.
 */
const useTestWebhookEndpoint = () => {
  const queryClient = useQueryClient();
  const axios = useWebhooksAxios();

  const mutationFn = async (id: string): Promise<{ deliveryId: string }> => {
    const res = await axios.post(`/webhooks/${id}/test`);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, id) => {
      await queryClient.invalidateQueries({
        queryKey: [`${deliveriesListKey(id)}-infinite`],
      });
      await queryClient.invalidateQueries({
        queryKey: ["webhook-endpoints", id],
      });
      toast.success("Test delivery queued");
    },
    onError: (error: CoreError) => {
      toast.error(errorMessage(error, "Failed to send test delivery"));
    },
  });
};

export default useTestWebhookEndpoint;
