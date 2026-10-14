import type { OrgRef, ServiceRef } from "@/lib/refs";

export interface RolePermission {
  id: string;
  name: string;
  displayName: string;
  /** A retired permission grants nothing but stays listed on custom roles. */
  retired: boolean;
  /** Counts when the role is assigned within an organization. */
  orgAssignable: boolean;
}

export interface Role {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  /**
   * System roles are declared in code by a service (`serviceId` set) and are
   * read-only to admins except for `requires2fa`; custom roles are made here.
   */
  isSystem: boolean;
  serviceId: string | null;
  /** The service `serviceId` names; null for a custom role. */
  service: ServiceRef | null;
  isActive: boolean;
  archivedAt: string | null;
  /** Set when a system role's service stopped declaring it; grants nothing. */
  retiredAt: string | null;
  requires2fa: boolean;
  createdAt: string;
  updatedAt: string;
  permissions?: RolePermission[];
}

export interface CreateRoleInput {
  name: string;
  displayName: string;
  description?: string;
  requires2fa?: boolean;
}

export interface UpdateRoleInput {
  name?: string;
  displayName?: string;
  description?: string;
  isActive?: boolean;
  requires2fa?: boolean;
}

export interface DuplicateRoleInput {
  name: string;
  displayName?: string;
  description?: string;
}

export interface RoleUser {
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
  /** The organization the assignment is scoped to; null when global. */
  organizationId: string | null;
  organization: OrgRef | null;
  expiresAt: string | null;
}
