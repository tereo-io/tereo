import { faCubes } from "@fortawesome/free-solid-svg-icons";
import { Sidebar, SidebarNavLink } from "@kosmeo-ui/react";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/lib/auth";

export const ServicesSidebar = () => {
  const { hasPermission } = useAuth();

  return (
    <Sidebar>
      {hasPermission("services.read") && (
        <SidebarNavLink as={NavLink} to="/services/list" icon={faCubes}>
          Services
        </SidebarNavLink>
      )}
    </Sidebar>
  );
};
