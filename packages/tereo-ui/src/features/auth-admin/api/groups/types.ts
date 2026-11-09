export interface Group {
  id: string;
  /** Null for a global group. */
  organizationId: string | null;
  slug: string;
  name: string;
  description: string | null;
  /** `provisioned` groups change only in provisioning documents. */
  definitionSource: "local" | "provisioned";
  membershipSource: "local";
  unprovisionedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
}

export interface GroupMember {
  userId: string;
  email: string;
  name: string | null;
  isActive: boolean;
  addedAt: string;
}

export interface GroupMembersPage {
  data: GroupMember[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

export interface GroupRole {
  id: string;
  name: string;
  displayName: string;
  /** The service that declares a system role; null for a custom role. */
  serviceId: string | null;
}

export interface CreateGroupInput {
  organizationId?: string | null;
  slug: string;
  name: string;
  description?: string | null;
  roleIds?: string[];
}

export interface UpdateGroupInput {
  slug?: string;
  name?: string;
  description?: string | null;
}

/** One of a user's groups, with its organization (null for a global group). */
export interface UserGroup extends Group {
  organization: { id: string; name: string } | null;
}
