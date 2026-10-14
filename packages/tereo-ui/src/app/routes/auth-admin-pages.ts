import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import type { PermissionRequirement } from "@/lib/auth";
import {
  faBuilding,
  faCog,
  faHome,
  faIdBadge,
  faKey,
  faServer,
  faUsers,
  faUserShield,
} from "@fortawesome/free-solid-svg-icons";

export interface AuthAdminPage {
  path: string;
  label: string;
  icon: IconDefinition;
  /** The read permission core's list endpoint checks; detail pages share it. */
  permission: PermissionRequirement;
}

// The dashboard counts users, roles, permissions and clients; any one of
// them is worth showing, and it hides the cards the user can't read.
const DASHBOARD_PERMISSIONS = [
  "users.read",
  "roles.read",
  "permissions.read",
  "clients.read",
];

/** Sidebar order. */
export const AUTH_ADMIN_PAGES: AuthAdminPage[] = [
  {
    path: "dashboard",
    label: "Dashboard",
    icon: faHome,
    permission: DASHBOARD_PERMISSIONS,
  },
  {
    path: "organizations",
    label: "Organizations",
    icon: faBuilding,
    permission: "organizations.read",
  },
  { path: "users", label: "Users", icon: faUsers, permission: "users.read" },
  {
    path: "roles",
    label: "Roles",
    icon: faUserShield,
    permission: "roles.read",
  },
  {
    path: "permissions",
    label: "Permissions",
    icon: faKey,
    permission: "permissions.read",
  },
  {
    path: "oauth-clients",
    label: "OAuth Clients",
    icon: faServer,
    permission: "clients.read",
  },
  {
    path: "identity-providers",
    label: "Identity Providers",
    icon: faIdBadge,
    permission: "identity-providers.read",
  },
  {
    path: "settings",
    label: "Settings",
    icon: faCog,
    permission: "settings.read",
  },
];

/** Reaching any Auth Admin page puts the section in the top bar. */
export const AUTH_ADMIN_PERMISSIONS = [
  ...new Set(
    AUTH_ADMIN_PAGES.flatMap((p) =>
      typeof p.permission === "string" ? [p.permission] : p.permission
    )
  ),
];
