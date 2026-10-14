import useWebhooksOrganization from "../../hooks/useWebhooksOrganization";
import useWebhooksAxios from "../useWebhooksAxios";
import { useQuery } from "@tanstack/react-query";
import type { WebhookDelivery } from "../types";

/** `GET /webhooks/:id/deliveries/:deliveryId` — includes the payload. */
const useDelivery = (endpointId: string, deliveryId: string | null) => {
  const axios = useWebhooksAxios();
  const { organizationId } = useWebhooksOrganization();

  const queryFn = async (): Promise<WebhookDelivery> => {
    const res = await axios.get(
      `/webhooks/${endpointId}/deliveries/${deliveryId}`
    );
    return res.data;
  };

  return useQuery({
    queryKey: ["webhook-deliveries", endpointId, deliveryId, organizationId],
    queryFn,
    enabled: !!endpointId && !!deliveryId,
  });
};

export default useDelivery;
