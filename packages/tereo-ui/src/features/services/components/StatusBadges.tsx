import type { Retirable, ServiceAccessStatus } from "../api/types";
import { formatDateTime } from "@/utils/formatDate";
import { Badge, Tooltip } from "@kosmeo-ui/react";

export const ServiceStatusBadge = ({ isActive }: { isActive: boolean }) =>
  isActive ? (
    <Badge size="sm" subtle variant="success">
      Active
    </Badge>
  ) : (
    <Badge size="sm" subtle variant="secondary">
      Inactive
    </Badge>
  );

/** Active, missing from the latest declaration, or retired. */
export const RetirementBadge = ({ item }: { item: Retirable }) => {
  if (item.retiredAt) {
    return (
      <Tooltip content={`Retired ${formatDateTime(item.retiredAt)}`}>
        <Badge size="sm" subtle variant="danger">
          Retired
        </Badge>
      </Tooltip>
    );
  }
  if (item.missingSince) {
    return (
      <Tooltip
        content={`Not declared since ${formatDateTime(item.missingSince)}; retires after the grace period unless declared again`}
      >
        <Badge size="sm" subtle variant="warning">
          Missing
        </Badge>
      </Tooltip>
    );
  }
  return (
    <Badge size="sm" subtle variant="success">
      Active
    </Badge>
  );
};

const ACCESS_VARIANT = {
  approved: "success",
  revoked: "danger",
} as const;

export const AccessStatusBadge = ({
  status,
}: {
  status: ServiceAccessStatus;
}) => (
  <Badge size="sm" subtle variant={ACCESS_VARIANT[status]}>
    {status}
  </Badge>
);
