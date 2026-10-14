import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import { deliveriesListKey } from "./useInfiniteDeliveries";
import useWebhooksAxios from "../useWebhooksAxios";
import type { WebhookDelivery } from "../types";
import { toast } from "react-toastify";

/**
 * `POST /webhooks/:id/deliveries/:deliveryId/retry` (`webhooks.write`) —
 * FAILED deliveries only, and not while the endpoint is archived. Resets the
 * delivery to PENDING and requeues it.
 */
const useRetryDelivery = () => {
  const queryClient = useQueryClient();
  const axios = useWebhooksAxios();

  const mutationFn = async (data: {
    endpointId: string;
    deliveryId: string;
  }): Promise<WebhookDelivery> => {
    const res = await axios.post(
      `/webhooks/${data.endpointId}/deliveries/${data.deliveryId}/retry`
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, { endpointId }) => {
      await queryClient.invalidateQueries({
        queryKey: [`${deliveriesListKey(endpointId)}-infinite`],
      });
      await queryClient.invalidateQueries({
        queryKey: ["webhook-deliveries", endpointId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["webhook-endpoints", endpointId, "stats"],
      });
      toast.success("Delivery queued for retry");
    },
    onError: (error: CoreError) => {
      toast.error(errorMessage(error, "Failed to retry delivery"));
    },
  });
};

export default useRetryDelivery;
