import type { AuthServiceUser } from "../users/types.js";

export type GuestStatus = "active" | "expired" | "deactivated";

/** A guest: an external person with an account that expires. */
export interface Guest extends Omit<AuthServiceUser, "userType"> {
  userType: "guest";
  /** ISO-8601 timestamp. */
  expiresAt: string;
  status: GuestStatus;
  /** The organization the guest belongs to; null when they belong to none. */
  organizationId: string | null;
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
  /** Set whenever a password setup link was issued, `notify` or not. */
  passwordSetupUrl?: string;
}

export interface PasswordSetupLink {
  url: string;
  /** ISO-8601 timestamp. */
  expiresAt: string;
}

/** A guest as `GET /v1/admin/guests` lists it. */
export type GuestListItem = Guest;

export interface ListGuestsOptions {
  limit?: number;
  /** `nextCursor` from the previous page. */
  cursor?: string;
  sort?: "id" | "email" | "createdAt" | "expiresAt";
  sortDir?: "asc" | "desc";
  organizationId?: string;
  /** Exact email. */
  email?: string;
  emailContains?: string;
  isActive?: boolean;
  expiresAt?: { gte?: Date | string; lte?: Date | string };
  createdAt?: { gte?: Date | string; lte?: Date | string };
}

export interface PaginatedGuests {
  data: GuestListItem[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

/** A custom role a guest may be given now. */
export interface GuestRoleOption {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
}

export interface GuestOptions {
  roles: GuestRoleOption[];
  /** The configured defaults among `roles`: what a guest invited without `roles` gets. */
  defaultRoleIds: string[];
  /** The furthest ahead, in seconds, an invitation or extension may set `expiresAt`. */
  maxTtlSeconds: number;
}
