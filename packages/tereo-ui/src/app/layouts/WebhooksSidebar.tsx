import { faList, faPlug } from "@fortawesome/free-solid-svg-icons";
import { useWebhooksOrganization } from "@/features/webhooks";
import { Sidebar, SidebarNavLink } from "@kosmeo-ui/react";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/lib/auth";

export const WebhooksSidebar = () => {
  const { hasPermission } = useAuth();
  const { search } = useWebhooksOrganization();

  return (
    <Sidebar>
      {hasPermission("webhooks.read") && (
        <SidebarNavLink
          as={NavLink}
          to={{ pathname: "/webhooks/endpoints", search }}
          icon={faPlug}
        >
          Endpoints
        </SidebarNavLink>
      )}
      {hasPermission("webhooks.event-types.read") && (
        <SidebarNavLink
          as={NavLink}
          to={{ pathname: "/webhooks/event-types", search }}
          icon={faList}
        >
          Event Types
        </SidebarNavLink>
      )}
    </Sidebar>
  );
};
