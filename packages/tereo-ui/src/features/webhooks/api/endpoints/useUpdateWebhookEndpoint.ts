import type { UpdateWebhookEndpointInput, WebhookEndpoint } from "../types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, type CoreError } from "../errorMessage";
import useWebhooksAxios from "../useWebhooksAxios";
import { toast } from "react-toastify";

// Core words this one for API callers (`customHeaders: null`). The form
// catches it before saving; this is for an endpoint that gained headers since
// the form opened.
const ORIGIN_MOVED_MESSAGE =
  "The URL moves to another host, so the saved header values are not carried over. Enter each header's value again, or remove the headers, then save.";

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
    onError: (error: CoreError, { updateData }) => {
      toast.error(
        error.response?.data?.error === "masked_header_value" &&
          updateData.url !== undefined
          ? ORIGIN_MOVED_MESSAGE
          : errorMessage(error, "Failed to update webhook endpoint")
      );
    },
  });
};

export default useUpdateWebhookEndpoint;
