import useRotateWebhookSecret from "../../../api/endpoints/useRotateWebhookSecret";
import { Button, ConfirmationModal, Modal } from "@kosmeo-ui/react";
import { WebhookSecretDisplay } from "../WebhookSecretDisplay";
import type { WebhookEndpoint } from "../../../api/types";
import { toast } from "react-toastify";
import { useAuth } from "@/lib/auth";
import { useState } from "react";

interface RotateSecretButtonProps {
  endpoint: WebhookEndpoint;
}

/** Requires `webhooks.admin`; core rejects it on archived endpoints. */
const RotateSecretButton = ({ endpoint }: RotateSecretButtonProps) => {
  const { hasPermission } = useAuth();
  const [showConfirm, setShowConfirm] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const rotateMutation = useRotateWebhookSecret();

  if (!hasPermission("webhooks.admin") || endpoint.archivedAt) return null;

  const handleRotate = () => {
    rotateMutation.mutate(endpoint.id, {
      onSuccess: (data) => {
        setShowConfirm(false);
        setNewSecret(data.signingSecret);
      },
      onError: () => setShowConfirm(false),
    });
  };

  const handleCloseSecretModal = () => {
    setNewSecret(null);
    toast.success("Signing secret rotated");
  };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setShowConfirm(true)}
        isLoading={rotateMutation.isPending}
      >
        Rotate Secret
      </Button>
      <ConfirmationModal
        show={showConfirm}
        handleHide={() => setShowConfirm(false)}
        handleConfirm={handleRotate}
        title="Rotate Signing Secret"
        body="Generate a new signing secret? For an overlap window (24 hours by default) deliveries are signed with both the new and the current secret, so the receiver can be updated in that window; the endpoint shows when it ends. Rotating again during that window drops the oldest secret."
        confirmButtonText={rotateMutation.isPending ? "Rotating..." : "Rotate"}
      />
      <Modal
        show={!!newSecret}
        onClose={handleCloseSecretModal}
        title="New Signing Secret"
        footerButtons={[
          <Button key="close" onClick={handleCloseSecretModal}>
            I have saved the signing secret
          </Button>,
        ]}
      >
        {newSecret && (
          <WebhookSecretDisplay url={endpoint.url} signingSecret={newSecret} />
        )}
      </Modal>
    </>
  );
};

export default RotateSecretButton;
