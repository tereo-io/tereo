import useWebhooksOrganization from "../../hooks/useWebhooksOrganization";
import type { WebhookEndpointStats } from "../types";
import useWebhooksAxios from "../useWebhooksAxios";
import { useQuery } from "@tanstack/react-query";

/** `GET /webhooks/:id/stats` — delivery counts, overall and last 24h. */
const useWebhookEndpointStats = (id: string) => {
  const axios = useWebhooksAxios();
  const { organizationId } = useWebhooksOrganization();

  const queryFn = async (): Promise<WebhookEndpointStats> => {
    const res = await axios.get(`/webhooks/${id}/stats`);
    return res.data;
  };

  return useQuery({
    queryKey: ["webhook-endpoints", id, "stats", organizationId],
    queryFn,
    enabled: !!id,
  });
};

export default useWebhookEndpointStats;
