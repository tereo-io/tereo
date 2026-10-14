import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { AUTH_ADMIN_PERMISSIONS } from "./routes/auth-admin-pages";
import { notificationsRoute } from "./routes/notifications";
import { fileStorageRoute } from "./routes/file-storage";
import type { PermissionRequirement } from "@/lib/auth";
import { authAdminRoute } from "./routes/auth-admin";
import type { RouteObject } from "react-router-dom";
import { auditLogRoute } from "./routes/audit-log";
import { webhooksRoute } from "./routes/webhooks";
import { servicesRoute } from "./routes/services";
import {
  faBell,
  faClipboardList,
  faCubes,
  faHdd,
  faPlug,
  faUserShield,
} from "@fortawesome/free-solid-svg-icons";

export interface SectionDef {
  /** RouteObject mounted under RootLayout. */
  route: RouteObject;
  /**
   * TopBar nav link metadata. `permission` gates the link per-user; for a
   * list, any one of them shows it.
   */
  nav: {
    to: string;
    label: string;
    icon: IconDefinition;
    permission: PermissionRequirement;
  };
}

/**
 * The top-level sections, one per area of core. Both the router and the
 * TopBar iterate this list. Account lives outside it: every user has one.
 *
 * Order here is the nav order.
 */
export const SECTIONS: SectionDef[] = [
  {
    route: authAdminRoute,
    nav: {
      to: "/auth-admin",
      label: "Auth Admin",
      icon: faUserShield,
      permission: AUTH_ADMIN_PERMISSIONS,
    },
  },
  {
    route: fileStorageRoute,
    nav: {
      to: "/file-storage",
      label: "File Storage",
      icon: faHdd,
      permission: "file-service.buckets.read",
    },
  },
  {
    route: webhooksRoute,
    nav: {
      to: "/webhooks",
      label: "Webhooks",
      icon: faPlug,
      permission: "webhooks.read",
    },
  },
  {
    route: notificationsRoute,
    nav: {
      to: "/notifications",
      label: "Notifications",
      icon: faBell,
      permission: "notifications.read",
    },
  },
  {
    route: auditLogRoute,
    nav: {
      to: "/audit-log",
      label: "Audit Log",
      icon: faClipboardList,
      permission: "audit-logs.read",
    },
  },
  {
    route: servicesRoute,
    nav: {
      to: "/services",
      label: "Services",
      icon: faCubes,
      permission: "services.read",
    },
  },
];
