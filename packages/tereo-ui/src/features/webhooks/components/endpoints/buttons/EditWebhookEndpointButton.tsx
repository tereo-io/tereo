import useUpdateWebhookEndpoint from "../../../api/endpoints/useUpdateWebhookEndpoint";
import { WebhookEndpointForm } from "../forms/WebhookEndpointForm";
import { Button, IconButton, Modal } from "@kosmeo-ui/react";
import { faEdit } from "@fortawesome/free-solid-svg-icons";
import { useAuth } from "@/lib/auth";
import { useState } from "react";
import type {
  UpdateWebhookEndpointInput,
  WebhookEndpoint,
} from "../../../api/types";

interface EditWebhookEndpointButtonProps {
  endpoint: WebhookEndpoint;
}

// Archived endpoints are read-only in core (PATCH 409s) until restored.
const EditWebhookEndpointButton = ({
  endpoint,
}: EditWebhookEndpointButtonProps) => {
  const { hasPermission } = useAuth();
  const [showEditModal, setShowEditModal] = useState(false);

  const updateMutation = useUpdateWebhookEndpoint();

  if (!hasPermission("webhooks.write") || endpoint.archivedAt) return null;

  const handleUpdate = (updateData: UpdateWebhookEndpointInput) => {
    if (Object.keys(updateData).length === 0) {
      setShowEditModal(false);
      return;
    }
    updateMutation.mutate(
      { id: endpoint.id, updateData },
      { onSuccess: () => setShowEditModal(false) }
    );
  };

  return (
    <>
      <IconButton
        icon={faEdit}
        title="Edit"
        variant="secondary"
        size="sm"
        onClick={() => setShowEditModal(true)}
      />
      <Modal
        show={showEditModal}
        onClose={() => setShowEditModal(false)}
        title="Edit Webhook Endpoint"
        size="lg"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={() => setShowEditModal(false)}
          >
            Cancel
          </Button>,
          <Button
            key="submit"
            type="submit"
            form="edit-webhook-endpoint-form"
            isLoading={updateMutation.isPending}
          >
            Update Endpoint
          </Button>,
        ]}
      >
        {showEditModal && (
          <WebhookEndpointForm
            formId="edit-webhook-endpoint-form"
            endpoint={endpoint}
            onSubmit={(data) =>
              handleUpdate(data as UpdateWebhookEndpointInput)
            }
          />
        )}
      </Modal>
    </>
  );
};

export default EditWebhookEndpointButton;
