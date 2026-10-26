import type { DeliveryStatus, NotificationStatus } from "../../api/types";
import { Badge } from "@kosmeo-ui/react";

const VARIANT = {
  pending: "warning",
  sending: "warning",
  sent: "success",
  partial: "warning",
  failed: "danger",
} as const;

export const STATUS_LABEL: Record<NotificationStatus | DeliveryStatus, string> =
  {
    pending: "Pending",
    sending: "Sending",
    sent: "Sent",
    partial: "Partial",
    failed: "Failed",
  };

export const NotificationStatusBadge = ({
  status,
}: {
  status: NotificationStatus | DeliveryStatus;
}) => (
  <Badge size="sm" subtle variant={VARIANT[status]}>
    {STATUS_LABEL[status]}
  </Badge>
);
