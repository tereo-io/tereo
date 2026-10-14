import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import useWebhooksAxios from "../useWebhooksAxios";
import type { WebhookEndpoint } from "../types";
import { toast } from "react-toastify";

/** `POST /webhooks/:id/restore` (`webhooks.archive`). Status is untouched. */
const useRestoreWebhookEndpoint = () => {
  const queryClient = useQueryClient();
  const axios = useWebhooksAxios();

  const mutationFn = async (id: string): Promise<WebhookEndpoint> => {
    const res = await axios.post(`/webhooks/${id}/restore`);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["webhook-endpoints"] });
      await queryClient.invalidateQueries({
        queryKey: ["webhook-endpoints-infinite"],
      });
      toast.success("Webhook endpoint restored");
    },
    onError: (error: CoreError) => {
      toast.error(errorMessage(error, "Failed to restore webhook endpoint"));
    },
  });
};

export default useRestoreWebhookEndpoint;
