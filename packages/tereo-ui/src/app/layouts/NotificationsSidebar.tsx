import { faEnvelope, faList } from "@fortawesome/free-solid-svg-icons";
import { Sidebar, SidebarNavLink } from "@kosmeo-ui/react";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/lib/auth";

export const NotificationsSidebar = () => {
  const { hasPermission } = useAuth();

  return (
    <Sidebar>
      {hasPermission("notifications.read") && (
        <SidebarNavLink as={NavLink} to="/notifications/log" icon={faList}>
          Log
        </SidebarNavLink>
      )}
      {hasPermission("notifications.read") && (
        <SidebarNavLink
          as={NavLink}
          to="/notifications/connections"
          icon={faEnvelope}
        >
          Connections
        </SidebarNavLink>
      )}
    </Sidebar>
  );
};
