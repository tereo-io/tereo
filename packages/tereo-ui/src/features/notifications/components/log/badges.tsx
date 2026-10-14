import type { DeliveryStatus, NotificationStatus } from "../../api/types";
import { Badge } from "@kosmeo-ui/react";

const VARIANT = {
  pending: "warning",
  sending: "warning",
  sent: "success",
  partial: "warning",
  failed: "danger",
} as const;

export const NotificationStatusBadge = ({
  status,
}: {
  status: NotificationStatus | DeliveryStatus;
}) => (
  <Badge size="sm" subtle variant={VARIANT[status]}>
    {status}
  </Badge>
);
