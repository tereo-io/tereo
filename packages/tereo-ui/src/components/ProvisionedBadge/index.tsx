import { Badge, Tooltip } from "@kosmeo-ui/react";

/** Marks a row a provisioning document declares; it changes there, not here. */
export const ProvisionedBadge = () => (
  <Tooltip content="Declared in a provisioning document. Change it there; it applies on the next deploy or provision run.">
    <Badge size="sm" subtle variant="secondary">
      Managed by provisioning
    </Badge>
  </Tooltip>
);
