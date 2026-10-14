import type { WebhookDeliveryStatus, WebhookEndpoint } from "../api/types";
import { Badge, Row } from "@kosmeo-ui/react";

const ENDPOINT_STATUS = {
  ACTIVE: { variant: "success", label: "Active" },
  PAUSED: { variant: "warning", label: "Paused" },
  DISABLED: { variant: "danger", label: "Disabled" },
} as const;

/** Operational status plus the (independent) archived marker. */
export const EndpointStatusBadges = ({
  endpoint,
}: {
  endpoint: Pick<WebhookEndpoint, "status" | "archivedAt">;
}) => {
  const s = ENDPOINT_STATUS[endpoint.status];
  return (
    <Row size="sm" align="center" wrap inline>
      <Badge size="sm" subtle variant={s.variant}>
        {s.label}
      </Badge>
      {endpoint.archivedAt && (
        <Badge size="sm" variant="warning">
          Archived
        </Badge>
      )}
    </Row>
  );
};

const DELIVERY_STATUS = {
  PENDING: "warning",
  SUCCESS: "success",
  FAILED: "danger",
} as const;

export const DeliveryStatusBadge = ({
  status,
}: {
  status: WebhookDeliveryStatus;
}) => (
  <Badge size="sm" subtle variant={DELIVERY_STATUS[status]}>
    {status.toLowerCase()}
  </Badge>
);
