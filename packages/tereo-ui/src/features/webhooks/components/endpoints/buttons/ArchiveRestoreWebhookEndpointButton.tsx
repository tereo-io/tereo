import useRestoreWebhookEndpoint from "../../../api/endpoints/useRestoreWebhookEndpoint";
import useArchiveWebhookEndpoint from "../../../api/endpoints/useArchiveWebhookEndpoint";
import useWebhooksOrganization from "../../../hooks/useWebhooksOrganization";
import { faBoxArchive, faBoxOpen } from "@fortawesome/free-solid-svg-icons";
import { ConfirmationModal, IconButton } from "@kosmeo-ui/react";
import type { WebhookEndpoint } from "../../../api/types";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useState } from "react";

interface ArchiveRestoreWebhookEndpointButtonProps {
  endpoint: WebhookEndpoint;
  /** Return to the list after archiving (archived rows are hidden there). */
  navigateOnArchive?: boolean;
}

// Archive and restore share the `archivedAt` marker, so one control flips
// between them. Archive works from any status and leaves status untouched.
const ArchiveRestoreWebhookEndpointButton = ({
  endpoint,
  navigateOnArchive = false,
}: ArchiveRestoreWebhookEndpointButtonProps) => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { search } = useWebhooksOrganization();
  const [showModal, setShowModal] = useState(false);

  const archiveMutation = useArchiveWebhookEndpoint();
  const restoreMutation = useRestoreWebhookEndpoint();

  if (!hasPermission("webhooks.archive")) return null;

  const isArchived = endpoint.archivedAt !== null;
  const isPending = archiveMutation.isPending || restoreMutation.isPending;

  const handleConfirm = () => {
    if (isArchived) {
      restoreMutation.mutate(endpoint.id, {
        onSuccess: () => setShowModal(false),
      });
    } else {
      archiveMutation.mutate(endpoint.id, {
        onSuccess: () =>
          navigateOnArchive
            ? navigate({ pathname: "/webhooks/endpoints", search })
            : setShowModal(false),
      });
    }
  };

  return (
    <>
      <IconButton
        icon={isArchived ? faBoxOpen : faBoxArchive}
        title={isArchived ? "Restore" : "Archive"}
        variant="secondary"
        size="sm"
        onClick={() => setShowModal(true)}
      />
      <ConfirmationModal
        show={showModal}
        handleHide={() => setShowModal(false)}
        handleConfirm={handleConfirm}
        title={isArchived ? "Restore Endpoint" : "Archive Endpoint"}
        body={
          isArchived
            ? `Restore the endpoint ${endpoint.url}? It will receive deliveries again if its status is Active.`
            : `Archive the endpoint ${endpoint.url}? It stops receiving deliveries and becomes read-only; you can restore it later.`
        }
        confirmButtonText={
          isPending
            ? isArchived
              ? "Restoring..."
              : "Archiving..."
            : isArchived
              ? "Restore"
              : "Archive"
        }
      />
    </>
  );
};

export default ArchiveRestoreWebhookEndpointButton;
