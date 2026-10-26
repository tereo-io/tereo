import { useState } from "react";
import "../styles.css";
import type {
  Role,
  CreateRoleInput,
  UpdateRoleInput,
} from "@/features/auth-admin/api/roles/types";
import {
  errorCodeOf,
  errorDescriptionOf,
  issuesOf,
  type FieldIssue,
} from "@/utils/apiErrors";
import {
  Checkbox,
  Col,
  Form,
  FormError,
  Input,
  Select,
  TextArea,
} from "@kosmeo-ui/react";

// Core's rule for a role name (routes/v1/admin/roles/schemas.ts).
const ROLE_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ROLE_NAME_RULE =
  "Starts with a letter; letters, numbers, underscores and hyphens only.";

const FIELD_PATHS = ["name", "displayName"];

/** A failed create or update, split into what goes under a field and what goes above them. */
export const roleFormErrors = (
  error: unknown,
  fallback: string
): { issues: FieldIssue[]; error?: string } => {
  if (!error) return { issues: [] };
  if (errorCodeOf(error) === "name_taken") {
    return {
      issues: [{ path: "name", message: "A role with this name exists." }],
    };
  }
  const issues = issuesOf(error);
  const elsewhere = issues.filter((i) => !FIELD_PATHS.includes(i.path));
  if (issues.length > 0 && elsewhere.length === 0) return { issues };
  return {
    issues,
    error:
      elsewhere.length > 0
        ? elsewhere.map((i) => `${i.path}: ${i.message}`).join("; ")
        : errorDescriptionOf(error, fallback),
  };
};

interface RoleFormProps {
  role?: Role;
  onSubmit: (data: CreateRoleInput | UpdateRoleInput) => void;
  formId?: string;
  /** Core's refusal of the last submit, shown under the fields it names. */
  issues?: FieldIssue[];
  /** A refusal tied to no field, shown above the fields. */
  error?: string;
}

export const RoleForm = ({
  role,
  onSubmit,
  formId,
  issues = [],
  error,
}: RoleFormProps) => {
  const [name, setName] = useState(role?.name || "");
  const [displayName, setDisplayName] = useState(role?.displayName || "");
  const [description, setDescription] = useState(role?.description || "");
  const [requires2fa, setRequires2fa] = useState(role?.requires2fa || false);
  const [isActive, setIsActive] = useState(
    role?.isActive !== undefined ? String(role.isActive) : "true"
  );
  const [nameError, setNameError] = useState<string | null>(null);

  const issueAt = (path: string) =>
    issues.find((i) => i.path === path)?.message;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!role?.isSystem && !ROLE_NAME.test(name)) {
      setNameError(ROLE_NAME_RULE);
      return;
    }
    setNameError(null);
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
        {error && <FormError>{error}</FormError>}
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
          onChange={(e) => {
            setName(e.target.value);
            setNameError(null);
          }}
          required
          disabled={role?.isSystem}
          placeholder="e.g., admin, editor, viewer"
          helperText={ROLE_NAME_RULE}
          error={nameError ?? issueAt("name")}
        />
        <Input
          label="Display Name"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          disabled={role?.isSystem}
          placeholder="e.g., Administrator, Editor, Viewer"
          error={issueAt("displayName")}
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
