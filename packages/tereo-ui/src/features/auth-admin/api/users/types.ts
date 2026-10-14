export interface User {
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
  userType: "human" | "service_account";
  /** False for a user who signs in only through an identity provider. */
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserRole {
  id: string;
  name: string;
  displayName: string;
  expiresAt: string | null;
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
}
