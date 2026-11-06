import type { AuthServiceUser } from "../users/types.js";

export type GuestStatus = "active" | "expired" | "deactivated";

/** A guest: an external person with an account that expires. */
export interface Guest extends Omit<AuthServiceUser, "userType"> {
  userType: "guest";
  /** ISO-8601 timestamp. */
  expiresAt: string;
  status: GuestStatus;
  passwordChangeRequired: boolean;
  hasPassword: boolean;
}

/** How the guest first gets in. */
export type GuestInitialAccess =
  | { type: "password_setup_link"; notify?: boolean }
  | { type: "password"; password: string; mustChange?: boolean };

interface InviteGuestBase {
  email: string;
  name?: string;
  organizationId?: string;
  /** Role names or ids; omitted: the deploy's `guests.defaultRoles`. */
  roles?: string[];
  initialAccess: GuestInitialAccess;
}

/** Exactly one of `expiresAt` and `expiresIn` (seconds). */
export type InviteGuestInput = InviteGuestBase &
  (
    | { expiresAt: Date | string; expiresIn?: never }
    | { expiresIn: number; expiresAt?: never }
  );

export interface InviteGuestResult {
  user: Guest;
  /** False when the email already belonged to a guest. */
  created: boolean;
  /** Set for `password_setup_link` access when `notify` is not true. */
  passwordSetupUrl?: string;
}

export interface PasswordSetupLink {
  url: string;
  /** ISO-8601 timestamp. */
  expiresAt: string;
}
