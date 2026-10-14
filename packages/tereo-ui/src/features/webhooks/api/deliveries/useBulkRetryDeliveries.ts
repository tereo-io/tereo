import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import { deliveriesListKey } from "./useInfiniteDeliveries";
import useWebhooksAxios from "../useWebhooksAxios";
import type { BulkRetryInput } from "../types";
import { toast } from "react-toastify";

/**
 * `POST /webhooks/:id/deliveries/retry` (`webhooks.write`) — requeues the
 * endpoint's FAILED deliveries matching the optional window and event type,
 * up to `limit` (default 100, max 1000). Returns `{ retriedCount }`.
 */
const useBulkRetryDeliveries = () => {
  const queryClient = useQueryClient();
  const axios = useWebhooksAxios();

  const mutationFn = async (data: {
    endpointId: string;
    input: BulkRetryInput;
  }): Promise<{ retriedCount: number }> => {
    const res = await axios.post(
      `/webhooks/${data.endpointId}/deliveries/retry`,
      data.input
    );
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async ({ retriedCount }, { endpointId }) => {
      await queryClient.invalidateQueries({
        queryKey: [`${deliveriesListKey(endpointId)}-infinite`],
      });
      await queryClient.invalidateQueries({
        queryKey: ["webhook-endpoints", endpointId, "stats"],
      });
      toast.success(
        retriedCount === 0
          ? "No failed deliveries matched"
          : `${retriedCount} ${retriedCount === 1 ? "delivery" : "deliveries"} queued for retry`
      );
    },
    onError: (error: CoreError) => {
      toast.error(errorMessage(error, "Failed to retry deliveries"));
    },
  });
};

export default useBulkRetryDeliveries;
