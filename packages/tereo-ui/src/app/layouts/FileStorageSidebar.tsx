import { faFolder } from "@fortawesome/free-solid-svg-icons";
import { Sidebar, SidebarNavLink } from "@kosmeo-ui/react";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/lib/auth";

export const FileStorageSidebar = () => {
  const { hasPermission } = useAuth();

  return (
    <Sidebar>
      {hasPermission("file-service.buckets.read") && (
        <SidebarNavLink as={NavLink} to="/file-storage/buckets" icon={faFolder}>
          Buckets
        </SidebarNavLink>
      )}
    </Sidebar>
  );
};
