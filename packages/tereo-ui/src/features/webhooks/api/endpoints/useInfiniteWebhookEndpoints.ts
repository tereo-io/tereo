import useWebhooksOrganization from "../../hooks/useWebhooksOrganization";
import { useInfiniteCursor } from "@kosmeo-ui/react";
import useWebhooksAxios from "../useWebhooksAxios";
import type { WebhookEndpoint } from "../types";
import { useAuth } from "@/lib/auth";

/**
 * `GET /webhooks` — filters: `status` (equals/in), `url` and `description`
 * (contains), `eventType` (equals/contains, over subscriptions) and `archived`
 * (true/false; unset hides archived endpoints).
 */
const useInfiniteWebhookEndpoints = () => {
  const { hasPermission } = useAuth();
  const { organizationId } = useWebhooksOrganization();
  const axios = useWebhooksAxios();

  return useInfiniteCursor<WebhookEndpoint>({
    axiosInstance: axios,
    endpoint: "/webhooks",
    queryKey: "webhook-endpoints",
    orgId: organizationId,
    initialLimit: 25,
    enabled: hasPermission("webhooks.read"),
  });
};

export default useInfiniteWebhookEndpoints;
