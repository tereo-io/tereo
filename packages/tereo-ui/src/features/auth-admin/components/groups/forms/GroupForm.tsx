import { Col, Form, Input, Select, TextArea } from "@kosmeo-ui/react";
import { useState } from "react";
import type {
  CreateGroupInput,
  Group,
  UpdateGroupInput,
} from "@/features/auth-admin/api/groups/types";
import {
  errorCodeOf,
  errorDescriptionOf,
  issuesOf,
  type FieldIssue,
} from "@/utils/apiErrors";

// Core's rule for a group slug (routes/v1/admin/groups/schemas.ts). The "-"
// is escaped: browsers compile `pattern` with the v flag, which needs it.
const SLUG_PATTERN = "[a-z0-9\\-]{1,100}";
const SLUG_RULE = "Lowercase letters, numbers and hyphens, up to 100.";

const FIELD_PATHS = ["slug", "name"];

/** A failed create or update, split into what goes under a field and what goes above them. */
export const groupFormErrors = (
  error: unknown,
  fallback: string
): { issues: FieldIssue[]; error?: string } => {
  if (!error) return { issues: [] };
  if (errorCodeOf(error) === "group_slug_taken") {
    return {
      issues: [{ path: "slug", message: errorDescriptionOf(error, "In use.") }],
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

interface OrganizationOption {
  id: string;
  name: string;
}

interface GroupFormProps {
  /** Present when editing; the organization cannot change then. */
  group?: Group;
  /** Create inside this organization, with no picker. */
  organizationId?: string;
  /** Create only: the organizations a picker offers, besides "Global". */
  organizations?: OrganizationOption[];
  onSubmit: (data: CreateGroupInput | UpdateGroupInput) => void;
  formId?: string;
  issues?: FieldIssue[];
  error?: string;
}

export const GroupForm = ({
  group,
  organizationId,
  organizations,
  onSubmit,
  formId,
  issues = [],
  error,
}: GroupFormProps) => {
  const [slug, setSlug] = useState(group?.slug ?? "");
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [orgChoice, setOrgChoice] = useState("global");

  const issueAt = (path: string) =>
    issues.find((i) => i.path === path)?.message;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (group) {
      const updates: UpdateGroupInput = {};
      if (slug !== group.slug) updates.slug = slug;
      if (name !== group.name && !group.managedBy) updates.name = name;
      if (description !== (group.description ?? ""))
        updates.description = description || null;
      onSubmit(updates);
      return;
    }
    const scope =
      organizationId ?? (orgChoice === "global" ? undefined : orgChoice);
    onSubmit({
      slug,
      name,
      description: description || undefined,
      ...(scope ? { organizationId: scope } : {}),
    });
  };

  return (
    <Form onSubmit={handleSubmit} id={formId} error={error}>
      <Col>
        {!group && !organizationId && organizations && (
          <Select
            label="Organization"
            value={orgChoice}
            options={[
              { value: "global", label: "Global (no organization)" },
              ...organizations.map((o) => ({ value: o.id, label: o.name })),
            ]}
            onChange={(value) => setOrgChoice(value ?? "global")}
          />
        )}
        <Input
          label="Name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={255}
          readOnly={!!group?.managedBy}
          helperText={
            group?.managedBy ? "Set by the identity provider." : undefined
          }
          placeholder="e.g., Support"
          error={issueAt("name")}
        />
        <Input
          label="Slug"
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          required
          pattern={SLUG_PATTERN}
          placeholder="e.g., support"
          helperText={SLUG_RULE}
          error={issueAt("slug")}
        />
        <TextArea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="Optional description of this group"
        />
      </Col>
    </Form>
  );
};
