import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import useWebhooksAxios from "../useWebhooksAxios";
import type { WebhookEndpoint } from "../types";
import { toast } from "react-toastify";

/** `POST /webhooks/:id/archive` (`webhooks.archive`). */
const useArchiveWebhookEndpoint = () => {
  const queryClient = useQueryClient();
  const axios = useWebhooksAxios();

  const mutationFn = async (id: string): Promise<WebhookEndpoint> => {
    const res = await axios.post(`/webhooks/${id}/archive`);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["webhook-endpoints"] });
      await queryClient.invalidateQueries({
        queryKey: ["webhook-endpoints-infinite"],
      });
      toast.success("Webhook endpoint archived");
    },
    onError: (error: CoreError) => {
      toast.error(errorMessage(error, "Failed to archive webhook endpoint"));
    },
  });
};

export default useArchiveWebhookEndpoint;
