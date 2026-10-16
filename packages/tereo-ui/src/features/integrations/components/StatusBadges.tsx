import { Badge } from "@kosmeo-ui/react";

export const IntegrationStatusBadge = ({ isActive }: { isActive: boolean }) => (
  <Badge size="sm" subtle variant={isActive ? "success" : "secondary"}>
    {isActive ? "Active" : "Inactive"}
  </Badge>
);

/** Org-bound integrations work in one organization; platform ones are global. */
export const ScopeBadge = ({ bound }: { bound: boolean }) => (
  <Badge size="sm" subtle variant={bound ? "primary" : "warning"}>
    {bound ? "Org-bound" : "Platform"}
  </Badge>
);
