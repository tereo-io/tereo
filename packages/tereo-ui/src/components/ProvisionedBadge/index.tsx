import { Badge, Tooltip } from "@kosmeo-ui/react";

/** Marks a row core's provisioning file declares; it changes there, not here. */
export const ProvisionedBadge = () => (
  <Tooltip content="Declared in the provisioning file. Change it there and restart core.">
    <Badge size="sm" subtle variant="secondary">
      Managed by provisioning
    </Badge>
  </Tooltip>
);
