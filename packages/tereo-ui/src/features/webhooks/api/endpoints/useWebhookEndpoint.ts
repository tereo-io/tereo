import useWebhooksOrganization from "../../hooks/useWebhooksOrganization";
import useWebhooksAxios from "../useWebhooksAxios";
import { useQuery } from "@tanstack/react-query";
import type { WebhookEndpoint } from "../types";

/** `GET /webhooks/:id` — the signing secret comes back masked. */
const useWebhookEndpoint = (id: string) => {
  const axios = useWebhooksAxios();
  const { organizationId } = useWebhooksOrganization();

  const queryFn = async (): Promise<WebhookEndpoint> => {
    const res = await axios.get(`/webhooks/${id}`);
    return res.data;
  };

  return useQuery({
    queryKey: ["webhook-endpoints", id, organizationId],
    queryFn,
    enabled: !!id,
  });
};

export default useWebhookEndpoint;
