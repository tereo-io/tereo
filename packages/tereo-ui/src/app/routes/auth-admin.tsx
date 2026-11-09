import { RequireGroupAccess } from "@/features/auth-admin/components/groups/RequireGroupAccess";
import { AuthAdminSidebar } from "../layouts/AuthAdminSidebar";
import { Navigate, type RouteObject } from "react-router-dom";
import { SectionLayout } from "../layouts/SectionLayout";
import { AUTH_ADMIN_PAGES } from "./auth-admin-pages";
import { RequireAuth } from "@/features/auth";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { namedLazy } from "./lazy";

const pagePermission = (path: string) =>
  AUTH_ADMIN_PAGES.find((p) => p.path === path)!.permission;

const gated = (path: string, element: ReactNode) => (
  <RequireAuth requiredPermission={pagePermission(path)}>{element}</RequireAuth>
);

const FirstAllowedPage = () => {
  const { hasPermission } = useAuth();
  const page = AUTH_ADMIN_PAGES.find((p) => hasPermission(p.permission));
  return (
    <Navigate to={page ? `/auth-admin/${page.path}` : "/account"} replace />
  );
};

export const authAdminRoute: RouteObject = {
  path: "auth-admin",
  element: <SectionLayout title="Auth Admin" sidebar={<AuthAdminSidebar />} />,
  children: [
    {
      index: true,
      element: <FirstAllowedPage />,
    },
    {
      path: "dashboard",
      element: gated(
        "dashboard",
        namedLazy(
          () => import("@/features/auth-admin/components/dashboard/Dashboard"),
          "Dashboard"
        )
      ),
    },
    {
      path: "users",
      element: gated(
        "users",
        namedLazy(
          () => import("@/features/auth-admin/components/users/UserList"),
          "UserList"
        )
      ),
    },
    {
      path: "users/:userId",
      element: gated(
        "users",
        namedLazy(
          () => import("@/features/auth-admin/components/users/UserDetail"),
          "UserDetail"
        )
      ),
    },
    {
      path: "groups",
      element: gated(
        "groups",
        namedLazy(
          () => import("@/features/auth-admin/components/groups/GroupList"),
          "GroupList"
        )
      ),
    },
    {
      path: "groups/:groupId",
      // Organization admins reach their groups from the organization's page.
      element: (
        <RequireGroupAccess>
          {namedLazy(
            () => import("@/features/auth-admin/components/groups/GroupDetail"),
            "GroupDetail"
          )}
        </RequireGroupAccess>
      ),
    },
    {
      path: "guests",
      element: gated(
        "guests",
        namedLazy(
          () => import("@/features/auth-admin/components/guests/GuestList"),
          "GuestList"
        )
      ),
    },
    {
      path: "roles",
      element: gated(
        "roles",
        namedLazy(
          () => import("@/features/auth-admin/components/roles/RoleList"),
          "RoleList"
        )
      ),
    },
    {
      path: "roles/:roleId",
      element: gated(
        "roles",
        namedLazy(
          () => import("@/features/auth-admin/components/roles/RoleDetail"),
          "RoleDetail"
        )
      ),
    },
    {
      path: "permissions",
      element: gated(
        "permissions",
        namedLazy(
          () =>
            import("@/features/auth-admin/components/permissions/PermissionList"),
          "PermissionList"
        )
      ),
    },
    {
      path: "organizations",
      element: gated(
        "organizations",
        namedLazy(
          () =>
            import("@/features/auth-admin/components/organizations/OrganizationList"),
          "OrganizationList"
        )
      ),
    },
    {
      path: "organizations/:organizationId",
      element: gated(
        "organizations",
        namedLazy(
          () =>
            import("@/features/auth-admin/components/organizations/OrganizationDetail"),
          "OrganizationDetail"
        )
      ),
    },
    {
      path: "oauth-clients",
      handle: { title: "OAuth Clients" },
      element: gated(
        "oauth-clients",
        namedLazy(
          () =>
            import("@/features/auth-admin/components/oauth-clients/ClientList"),
          "ClientList"
        )
      ),
    },
    {
      path: "oauth-clients/:clientId",
      element: gated(
        "oauth-clients",
        namedLazy(
          () =>
            import("@/features/auth-admin/components/oauth-clients/ClientDetail"),
          "ClientDetail"
        )
      ),
    },
    {
      path: "identity-providers",
      element: gated(
        "identity-providers",
        namedLazy(
          () =>
            import("@/features/auth-admin/components/identity-providers/IdentityProviderList"),
          "IdentityProviderList"
        )
      ),
    },
    {
      path: "identity-providers/:providerId",
      element: gated(
        "identity-providers",
        namedLazy(
          () =>
            import("@/features/auth-admin/components/identity-providers/IdentityProviderDetail"),
          "IdentityProviderDetail"
        )
      ),
    },
    {
      path: "branding",
      element: gated(
        "branding",
        namedLazy(
          () =>
            import("@/features/auth-admin/components/branding/BrandingList"),
          "BrandingList"
        )
      ),
    },
    {
      path: "branding/default",
      element: gated(
        "branding",
        namedLazy(
          () =>
            import("@/features/auth-admin/components/branding/BrandingPages"),
          "DefaultBrandingPage"
        )
      ),
    },
    {
      path: "branding/clients/:id",
      element: gated(
        "branding",
        namedLazy(
          () =>
            import("@/features/auth-admin/components/branding/BrandingPages"),
          "ClientBrandingPage"
        )
      ),
    },
    {
      path: "settings",
      element: gated(
        "settings",
        namedLazy(
          () =>
            import("@/features/auth-admin/components/settings/SettingsPage"),
          "SettingsPage"
        )
      ),
    },
  ],
};
