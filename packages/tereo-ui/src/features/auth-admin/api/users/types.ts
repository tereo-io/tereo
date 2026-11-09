export interface User {
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
  userType: "human" | "service_account" | "guest";
  /** When a guest's access ends; null for everyone else. */
  expiresAt: string | null;
  /** A guest past `expiresAt` is `expired`; an admin's deactivation is `deactivated`. */
  status: "active" | "expired" | "deactivated";
  /** Set until the user replaces a password an admin chose for them. */
  passwordChangeRequired: boolean;
  /** False for a user who signs in only through an identity provider. */
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What owns an account the admin API refuses to change. */
export type UserManager =
  | { kind: "system" }
  | { kind: "service" | "integration"; id: string; name: string };

export interface UserDetail extends User {
  managedBy: UserManager | null;
  /** Requests per second this account may make; null follows the default. */
  rateLimitPerSecond?: number | null;
}

export interface UserRole {
  id: string;
  name: string;
  displayName: string;
  expiresAt: string | null;
}

/** A role held through a group; `PUT .../roles` never touches these. */
export interface UserGroupRole {
  id: string;
  name: string;
  displayName: string;
  organizationId: string | null;
  via: { kind: "group"; groupId: string };
  group: { id: string; slug: string; name: string };
}

export interface UserRolesResponse {
  userId: string;
  /** Direct assignments only: the set the roles editor sends back. */
  roles: UserRole[];
  groupRoles?: UserGroupRole[];
}

export interface UserSession {
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export interface CreateUserInput {
  email: string;
  /** Omit for a user who signs in through an identity provider only. */
  password?: string;
  name?: string;
  userType: "human";
}

export interface UpdateUserInput {
  email?: string;
  password?: string;
  name?: string;
  isActive?: boolean;
  /** Null returns the account to the default. */
  rateLimitPerSecond?: number | null;
}
