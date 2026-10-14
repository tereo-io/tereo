import useWebhooksOrganization from "../../hooks/useWebhooksOrganization";
import { useInfiniteCursor } from "@kosmeo-ui/react";
import useWebhooksAxios from "../useWebhooksAxios";
import type { WebhookDelivery } from "../types";
import { useAuth } from "@/lib/auth";

/** The list's React Query key stem (`useInfiniteCursor` appends `-infinite`). */
export const deliveriesListKey = (endpointId: string) =>
  `webhook-deliveries:${endpointId}`;

/**
 * `GET /webhooks/:id/deliveries` — filters: `status` (equals/in),
 * `eventType` (equals) and a `createdAt` range (`_gte`/`_lte`); sortable by
 * `createdAt` only.
 */
const useInfiniteDeliveries = (endpointId: string) => {
  const { hasPermission } = useAuth();
  const { organizationId } = useWebhooksOrganization();
  const axios = useWebhooksAxios();

  return useInfiniteCursor<WebhookDelivery>({
    axiosInstance: axios,
    endpoint: `/webhooks/${endpointId}/deliveries`,
    queryKey: deliveriesListKey(endpointId),
    orgId: organizationId,
    initialLimit: 25,
    enabled: !!endpointId && hasPermission("webhooks.read"),
  });
};

export default useInfiniteDeliveries;
