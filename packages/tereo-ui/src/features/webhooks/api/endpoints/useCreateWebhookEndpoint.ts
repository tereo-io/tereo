import type { CreateWebhookEndpointInput, WebhookEndpoint } from "../types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import useWebhooksAxios from "../useWebhooksAxios";
import { toast } from "react-toastify";

/** `POST /webhooks` — the response carries the full signing secret, once. */
const useCreateWebhookEndpoint = () => {
  const queryClient = useQueryClient();
  const axios = useWebhooksAxios();

  const mutationFn = async (
    data: CreateWebhookEndpointInput
  ): Promise<WebhookEndpoint> => {
    const res = await axios.post("/webhooks", data);
    return res.data;
  };

  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["webhook-endpoints"] });
      await queryClient.invalidateQueries({
        queryKey: ["webhook-endpoints-infinite"],
      });
    },
    onError: (error: CoreError) => {
      toast.error(errorMessage(error, "Failed to create webhook endpoint"));
    },
  });
};

export default useCreateWebhookEndpoint;
