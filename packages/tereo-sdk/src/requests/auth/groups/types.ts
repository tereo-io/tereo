/**
 * A group as `/v1/admin/groups` returns it.
 *
 * Errors the group requests can raise (as `error` codes of the response),
 * besides the generic `forbidden`, `not_found` and validation errors:
 * - 400: `unknown_role`, `role_not_org_assignable`, `unknown_organization`,
 *   `unknown_user`;
 * - 409: `not_org_member`, `guest_not_allowed`, `service_account_not_allowed`,
 *   `system_user_not_allowed`, `group_slug_taken`, `managed_by_provisioning`,
 *   `resource_archived` (the group is archived), `already_archived`,
 *   `not_archived`, and `conflict` (the change would leave no active
 *   administrator).
 */
export interface Group {
  id: string;
  /** The organization the group belongs to; null for a global group. */
  organizationId: string | null;
  /** Unique among the scope's groups, archived ones included. */
  slug: string;
  name: string;
  description: string | null;
  /** `provisioned` groups change only through provisioning documents. */
  definitionSource: "local" | "provisioned";
  membershipSource: "local";
  /** ISO-8601; when provisioning found a provisioned group missing. */
  unprovisionedAt: string | null;
  /** ISO-8601; null for a live group. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
}

export interface ListGroupsQuery {
  /** `global` for global groups only, or an organization id. */
  organizationId?: string;
  definitionSource?: "local" | "provisioned";
  /** Include archived groups; by default they are left out. */
  includeArchived?: boolean;
  q?: string;
  cursor?: string;
  /** 1 to 100, default 50. */
  limit?: number;
}

export interface PaginatedGroups {
  data: Group[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface CreateGroupBody {
  /** Omit or null for a global group. Fixed once created. */
  organizationId?: string | null;
  slug: string;
  name: string;
  description?: string | null;
  roleIds?: string[];
}

/** At least one field. */
export interface UpdateGroupBody {
  slug?: string;
  name?: string;
  description?: string | null;
}

export interface GroupMember {
  userId: string;
  email: string;
  name: string | null;
  isActive: boolean;
  /** ISO-8601 timestamp. */
  addedAt: string;
}

export interface ListGroupMembersQuery {
  cursor?: string;
  limit?: number;
}

export interface ListUserGroupsQuery {
  /** Include archived groups; by default they are left out. */
  includeArchived?: boolean;
}

export interface PaginatedGroupMembers {
  data: GroupMember[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface AddGroupMembersResult {
  /** The users who were not members before. */
  added: string[];
}

export interface GroupRole {
  id: string;
  name: string;
  displayName: string;
  /** The service that declares a system role; null for a custom role. */
  serviceId: string | null;
}

/** Every role the group holds; not paginated. */
export interface GroupRolesResult {
  data: GroupRole[];
  nextCursor: null;
}

export interface SetGroupRolesResult {
  roles: GroupRole[];
  added: string[];
  removed: string[];
}

/** The groups the user belongs to; not paginated. */
export interface UserGroupsResult {
  data: Group[];
  nextCursor: null;
}
