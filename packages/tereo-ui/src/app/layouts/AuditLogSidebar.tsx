import { faClipboardList } from "@fortawesome/free-solid-svg-icons";
import { Sidebar, SidebarNavLink } from "@kosmeo-ui/react";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/lib/auth";

export const AuditLogSidebar = () => {
  const { hasPermission } = useAuth();

  return (
    <Sidebar>
      {hasPermission("audit-logs.read") && (
        <SidebarNavLink
          as={NavLink}
          to="/audit-log/entries"
          icon={faClipboardList}
        >
          Entries
        </SidebarNavLink>
      )}
    </Sidebar>
  );
};
