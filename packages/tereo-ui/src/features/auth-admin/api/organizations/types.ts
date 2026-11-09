import type { UserGroupRole } from "../users/types";

export type MemberRole = "owner" | "admin" | "member";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  code: string;
  isDefault: boolean;
  isActive: boolean;
  archivedAt: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMember {
  id: string;
  memberRole: MemberRole;
  createdAt: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    isActive: boolean;
  };
}

export interface OrganizationMembersResponse {
  organizationId: string;
  members: OrganizationMember[];
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
  code: string;
}

export interface UpdateOrganizationInput {
  name?: string;
  slug?: string;
  isActive?: boolean;
}

export interface AddMemberInput {
  userId: string;
  memberRole: MemberRole;
}

export interface UpdateMemberRoleInput {
  memberRole: MemberRole;
}

/** A role a member holds within one organization (custom roles only). */
export interface MemberOrgRole {
  id: string;
  name: string;
  displayName: string;
  expiresAt: string | null;
  via: { kind: "direct" };
}

export interface MemberOrgRolesResponse {
  organizationId: string;
  userId: string;
  /** Direct assignments only: the set the roles editor sends back. */
  roles: MemberOrgRole[];
  /** Held through the organization's groups; `PUT` never touches these. */
  groupRoles: UserGroupRole[];
}
