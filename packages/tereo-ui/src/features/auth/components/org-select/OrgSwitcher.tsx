import { Select, type Size } from "@kosmeo-ui/react";
import { useAuth } from "@/lib/auth";
import { useMemo } from "react";

export interface OrgSwitcherProps {
  label?: string;
  size?: Size;
}

export const OrgSwitcher = ({ label, size = "sm" }: OrgSwitcherProps) => {
  const { organizations, currentOrganization, switchOrganization } = useAuth();

  const options = useMemo(
    () =>
      organizations.map((org) => ({ value: String(org.id), label: org.name })),
    [organizations]
  );

  if (organizations.length <= 1) return null;

  return (
    <Select
      label={label}
      size={size}
      value={currentOrganization ? String(currentOrganization.id) : undefined}
      options={options}
      onChange={(value) => {
        if (value) switchOrganization(value);
      }}
    />
  );
};
