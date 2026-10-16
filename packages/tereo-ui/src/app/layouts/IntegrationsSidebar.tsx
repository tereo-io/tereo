import { faHandshake } from "@fortawesome/free-solid-svg-icons";
import { Sidebar, SidebarNavLink } from "@kosmeo-ui/react";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/lib/auth";

export const IntegrationsSidebar = () => {
  const { hasPermission } = useAuth();

  return (
    <Sidebar>
      {hasPermission("integrations.read") && (
        <SidebarNavLink as={NavLink} to="/integrations/list" icon={faHandshake}>
          Integrations
        </SidebarNavLink>
      )}
    </Sidebar>
  );
};
