import { Col, Form, Input, Select, TextArea, Checkbox } from "@kosmeo-ui/react";
import { useState } from "react";
import "../styles.css";
import type {
  Role,
  CreateRoleInput,
  UpdateRoleInput,
} from "@/features/auth-admin/api/roles/types";

interface RoleFormProps {
  role?: Role;
  onSubmit: (data: CreateRoleInput | UpdateRoleInput) => void;
  formId?: string;
}

export const RoleForm = ({ role, onSubmit, formId }: RoleFormProps) => {
  const [name, setName] = useState(role?.name || "");
  const [displayName, setDisplayName] = useState(role?.displayName || "");
  const [description, setDescription] = useState(role?.description || "");
  const [requires2fa, setRequires2fa] = useState(role?.requires2fa || false);
  const [isActive, setIsActive] = useState(
    role?.isActive !== undefined ? String(role.isActive) : "true"
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (role) {
      // Update mode. A system role is declared in code; core accepts only
      // its 2FA policy and 403s any other field.
      const updates: UpdateRoleInput = {};
      if (requires2fa !== role.requires2fa) updates.requires2fa = requires2fa;
      if (!role.isSystem) {
        if (name !== role.name) updates.name = name;
        if (displayName !== role.displayName) updates.displayName = displayName;
        if (description !== (role.description || ""))
          updates.description = description;
        if (String(role.isActive) !== isActive)
          updates.isActive = isActive === "true";
      }
      onSubmit(updates);
    } else {
      // Create mode
      onSubmit({
        name,
        displayName,
        description: description || undefined,
        requires2fa,
      });
    }
  };

  return (
    <Form onSubmit={handleSubmit} id={formId}>
      <Col>
        {role?.isSystem && (
          <p className="v-help-text">
            This system role is declared in code by its service. Only its
            two-factor requirement can be changed here; duplicate it to make an
            editable custom role.
          </p>
        )}
        <Input
          label="Name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          disabled={role?.isSystem}
          placeholder="e.g., admin, editor, viewer"
        />
        <Input
          label="Display Name"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          disabled={role?.isSystem}
          placeholder="e.g., Administrator, Editor, Viewer"
        />
        <TextArea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={role?.isSystem}
          placeholder="Optional description of this role"
          rows={3}
        />
        {role && !role.isSystem && (
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
        <div className="t-role-2fa-section">
          <Checkbox
            label="Require Two-Factor Authentication"
            labelLocation="right"
            checked={requires2fa}
            onChange={(e) => setRequires2fa(e.target.checked)}
          />
          <p className="v-help-text">
            Users with this role must set up and use two-factor authentication.
          </p>
        </div>
      </Col>
    </Form>
  );
};
