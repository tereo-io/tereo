import type { UpdateWebhookEndpointInput, WebhookEndpoint } from "../types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import useWebhooksAxios from "../useWebhooksAxios";
import { toast } from "react-toastify";

/** `PATCH /webhooks/:id` — 409s while the endpoint is archived. */
const useUpdateWebhookEndpoint = () => {
  const queryClient = useQueryClient();
  const axios = useWebhooksAxios();

  const mutationFn = async (data: {
    id: string;
    updateData: UpdateWebhookEndpointInput;
  }): Promise<WebhookEndpoint> => {
    const res = await axios.patch(`/webhooks/${data.id}`, data.updateData);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["webhook-endpoints"] });
      await queryClient.invalidateQueries({
        queryKey: ["webhook-endpoints-infinite"],
      });
      toast.success("Webhook endpoint updated");
    },
    onError: (error: CoreError) => {
      toast.error(errorMessage(error, "Failed to update webhook endpoint"));
    },
  });
};

export default useUpdateWebhookEndpoint;
