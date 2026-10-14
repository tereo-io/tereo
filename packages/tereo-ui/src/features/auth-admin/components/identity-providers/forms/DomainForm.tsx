import useAllOrganizations from "@/features/auth-admin/api/organizations/useAllOrganizations";
import useAllRoles from "@/features/auth-admin/api/roles/useAllRoles";
import { useState } from "react";
import type {
  ProviderDomain,
  ProviderDomainInput,
} from "@/features/auth-admin/api/identity-providers/types";
import {
  Alert,
  Checkbox,
  Col,
  Form,
  Input,
  MultiSelect,
  Select,
} from "@kosmeo-ui/react";

interface DomainFormProps {
  domain?: ProviderDomain;
  onSubmit: (data: ProviderDomainInput) => void;
  formId?: string;
}

export const DomainForm = ({ domain, onSubmit, formId }: DomainFormProps) => {
  const { data: organizations } = useAllOrganizations();
  const { data: roles } = useAllRoles();
  const [name, setName] = useState(domain?.domain || "");
  const [organizationId, setOrganizationId] = useState(
    domain?.organization.id || ""
  );
  const [roleIds, setRoleIds] = useState<string[]>(
    domain?.roles.map((r) => r.id) ?? []
  );
  const [autoAccept, setAutoAccept] = useState(domain?.autoAccept ?? false);
  const [ssoOnly, setSsoOnly] = useState(domain?.ssoOnly ?? false);

  const assignable = (roles ?? []).filter((r) => r.isActive && !r.retiredAt);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      domain: name.trim().toLowerCase(),
      organizationId,
      autoAccept,
      ssoOnly,
      roleIds,
    });
  };

  return (
    <Form onSubmit={handleSubmit} id={formId}>
      <Col>
        <Input
          label="Email domain"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="example.com"
        />
        <Select
          label="Organization"
          required
          placeholder="Select an organization"
          value={organizationId}
          onChange={(value) => setOrganizationId(value ?? "")}
          options={(organizations ?? []).map((o) => ({
            value: o.id,
            label: o.name,
          }))}
        />
        <MultiSelect
          label="Default roles"
          placeholder="Roles given to new users from this domain"
          options={assignable}
          labelKey="displayName"
          value={assignable.filter((r) => roleIds.includes(r.id))}
          onChange={(selected) => setRoleIds(selected.map((r) => r.id))}
        />
        <Checkbox
          id="domain-auto-accept"
          checked={autoAccept}
          onChange={(e) => setAutoAccept(e.target.checked)}
          label="Create an account on first sign-in (auto-accept)"
          labelLocation="right"
        />
        <Checkbox
          id="domain-sso-only"
          checked={ssoOnly}
          onChange={(e) => setSsoOnly(e.target.checked)}
          label="Require this provider (SSO-only): no password sign-in"
          labelLocation="right"
        />
        {ssoOnly && (
          <Alert variant="warning">
            People with this email domain can no longer sign in with a password.
            Their existing password is cleared once they connect the provider.
          </Alert>
        )}
      </Col>
    </Form>
  );
};
