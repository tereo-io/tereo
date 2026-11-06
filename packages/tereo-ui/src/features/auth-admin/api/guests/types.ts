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
