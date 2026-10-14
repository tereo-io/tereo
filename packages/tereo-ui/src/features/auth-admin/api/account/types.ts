export interface AccountRole {
  id: string;
  name: string;
  displayName: string;
  expiresAt: string | null;
}

export interface AccountTotp {
  enabled: boolean;
  enabledAt: string | null;
  required: boolean;
  recoveryCodesRemaining: number;
}

export interface AccountProfile {
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  photoUrl: string | null;
  /** False for an account that signs in only through a provider. */
  hasPassword: boolean;
  roles: AccountRole[];
  permissions: string[];
  totp: AccountTotp;
}

export interface AccountSession {
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export interface AccountSessionsResponse {
  sessions: AccountSession[];
}
