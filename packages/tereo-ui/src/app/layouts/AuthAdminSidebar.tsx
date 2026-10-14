import { AUTH_ADMIN_PAGES } from "../routes/auth-admin-pages";
import { Sidebar, SidebarNavLink } from "@kosmeo-ui/react";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/lib/auth";

export const AuthAdminSidebar = () => {
  const { hasPermission } = useAuth();

  return (
    <Sidebar>
      {AUTH_ADMIN_PAGES.filter((page) => hasPermission(page.permission)).map(
        (page) => (
          <SidebarNavLink
            key={page.path}
            as={NavLink}
            to={`/auth-admin/${page.path}`}
            icon={page.icon}
          >
            {page.label}
          </SidebarNavLink>
        )
      )}
    </Sidebar>
  );
};
