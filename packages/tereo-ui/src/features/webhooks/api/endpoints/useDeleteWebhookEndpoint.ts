import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import useWebhooksAxios from "../useWebhooksAxios";
import { toast } from "react-toastify";

/**
 * `DELETE /webhooks/:id` — a hard delete. Core 409s while delivery history
 * still references the endpoint (until retention purges it); archive instead.
 */
const useDeleteWebhookEndpoint = () => {
  const queryClient = useQueryClient();
  const axios = useWebhooksAxios();

  const mutationFn = async (id: string): Promise<void> => {
    await axios.delete(`/webhooks/${id}`);
  };

  return useMutation({
    mutationFn,
    onSuccess: async (_, id) => {
      queryClient.removeQueries({ queryKey: ["webhook-endpoints", id] });
      await queryClient.invalidateQueries({ queryKey: ["webhook-endpoints"] });
      await queryClient.invalidateQueries({
        queryKey: ["webhook-endpoints-infinite"],
      });
      toast.success("Webhook endpoint deleted");
    },
    onError: (error: CoreError) => {
      toast.error(errorMessage(error, "Failed to delete webhook endpoint"));
    },
  });
};

export default useDeleteWebhookEndpoint;
