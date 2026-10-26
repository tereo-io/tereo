import { Col, Form, Input, Select } from "@kosmeo-ui/react";
import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import type {
  Organization,
  CreateOrganizationInput,
  UpdateOrganizationInput,
} from "@/features/auth-admin/api/organizations/types";

interface OrganizationFormProps {
  organization?: Organization;
  onSubmit: (data: CreateOrganizationInput | UpdateOrganizationInput) => void;
  formId?: string;
}

// Core's rule for a slug (routes/v1/admin/organizations/schemas.ts). The "-"
// is escaped: browsers compile `pattern` with the v flag, which needs it.
const SLUG_PATTERN = "[a-z0-9][a-z0-9\\-]*";
const SLUG_RULE =
  "Starts with a letter or number; lowercase letters, numbers and hyphens only.";

const toSlug = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
};

export const OrganizationForm = ({
  organization,
  onSubmit,
  formId,
}: OrganizationFormProps) => {
  const [name, setName] = useState(organization?.name || "");
  const [slug, setSlug] = useState(organization?.slug || "");
  const [code, setCode] = useState(organization?.code || "");
  const [isActive, setIsActive] = useState(
    organization?.isActive !== undefined
      ? String(organization.isActive)
      : "true"
  );
  const [autoSlug, setAutoSlug] = useState(!organization);
  // Activating and deactivating is the platform's call, not an owner's.
  const canSetStatus = useAuth().hasPermission("organizations.write");

  useEffect(() => {
    if (autoSlug && !organization) {
      setSlug(toSlug(name));
    }
  }, [name, autoSlug, organization]);

  const handleSlugChange = (value: string) => {
    setAutoSlug(false);
    setSlug(value);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (organization) {
      const updates: UpdateOrganizationInput = {};
      if (name !== organization.name) updates.name = name;
      if (slug !== organization.slug) updates.slug = slug;
      if (String(organization.isActive) !== isActive)
        updates.isActive = isActive === "true";
      onSubmit(updates);
    } else {
      onSubmit({ name, slug, code });
    }
  };

  return (
    <Form onSubmit={handleSubmit} id={formId}>
      <Col>
        <Input
          label="Name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Input
          label="Slug"
          type="text"
          value={slug}
          onChange={(e) => handleSlugChange(e.target.value)}
          required
          placeholder="auto-generated-from-name"
          pattern={SLUG_PATTERN}
          helperText={SLUG_RULE}
        />
        <Input
          label="Code"
          type="text"
          value={code}
          onChange={(e) =>
            setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
          }
          required={!organization}
          disabled={!!organization}
          max={6}
          placeholder="e.g. ACME"
        />
        {organization && canSetStatus && (
          <Select
            label="Status"
            value={isActive}
            options={[
              { value: "true", label: "Active" },
              { value: "false", label: "Inactive" },
            ]}
            onChange={(value) => setIsActive(value ?? "false")}
          />
        )}
      </Col>
    </Form>
  );
};
