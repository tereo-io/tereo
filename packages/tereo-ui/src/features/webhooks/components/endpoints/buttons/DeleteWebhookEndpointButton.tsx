import useDeleteWebhookEndpoint from "../../../api/endpoints/useDeleteWebhookEndpoint";
import useWebhooksOrganization from "../../../hooks/useWebhooksOrganization";
import { ConfirmationModal, IconButton } from "@kosmeo-ui/react";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import type { WebhookEndpoint } from "../../../api/types";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useState } from "react";

interface DeleteWebhookEndpointButtonProps {
  endpoint: WebhookEndpoint;
}

/**
 * Hard delete, offered only while no delivery history references the endpoint
 * (core 409s otherwise). Archive is the routine way to retire one.
 */
const DeleteWebhookEndpointButton = ({
  endpoint,
}: DeleteWebhookEndpointButtonProps) => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { search } = useWebhooksOrganization();
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const deleteMutation = useDeleteWebhookEndpoint();

  if (!hasPermission("webhooks.delete") || endpoint.hasDeliveries) return null;

  const handleDelete = () => {
    deleteMutation.mutate(endpoint.id, {
      onSuccess: () => navigate({ pathname: "/webhooks/endpoints", search }),
      onError: () => setShowDeleteModal(false),
    });
  };

  return (
    <>
      <IconButton
        icon={faTrash}
        title="Delete"
        variant="danger"
        size="sm"
        onClick={() => setShowDeleteModal(true)}
      />
      <ConfirmationModal
        show={showDeleteModal}
        handleHide={() => setShowDeleteModal(false)}
        handleConfirm={handleDelete}
        title="Delete Endpoint"
        body={`Permanently delete the endpoint ${endpoint.url}? This cannot be undone.`}
        confirmButtonText={deleteMutation.isPending ? "Deleting..." : "Delete"}
      />
    </>
  );
};

export default DeleteWebhookEndpointButton;
