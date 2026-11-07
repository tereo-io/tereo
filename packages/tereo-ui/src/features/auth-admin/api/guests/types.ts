import type { UserDetail } from "../users/types";

export type InitialAccess =
  | { type: "password_setup_link"; notify?: boolean }
  | { type: "password"; password: string; mustChange?: boolean };

export interface InviteGuestInput {
  email: string;
  name?: string;
  organizationId?: string;
  roles?: string[];
  expiresIn?: number;
  expiresAt?: string;
  initialAccess: InitialAccess;
}

export interface InviteGuestResult {
  user: UserDetail;
  created: boolean;
  passwordSetupUrl?: string;
}

export interface PasswordSetupLink {
  url: string;
  expiresAt: string;
}

/** A custom role a guest may be given now. */
export interface GuestRoleOption {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
}

/** `GET /v1/admin/guests/options`: what the invite form needs without roles.read. */
export interface GuestOptions {
  roles: GuestRoleOption[];
  /** The defaults among `roles`: what a guest invited without `roles` gets. */
  defaultRoleIds: string[];
  /** The furthest ahead an invitation or extension may set the expiry. */
  maxTtlSeconds: number;
}
