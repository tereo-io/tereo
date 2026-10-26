import useRevokePreviousWebhookSecret from "../../../api/endpoints/useRevokePreviousWebhookSecret";
import { Button, ConfirmationModal } from "@kosmeo-ui/react";
import type { WebhookEndpoint } from "../../../api/types";
import { formatDateTime } from "@/utils/formatDate";
import { useAuth } from "@/lib/auth";
import { useState } from "react";

interface RevokePreviousSecretButtonProps {
  endpoint: WebhookEndpoint;
}

/** Shown only while a rotation overlap is in progress. */
const RevokePreviousSecretButton = ({
  endpoint,
}: RevokePreviousSecretButtonProps) => {
  const { hasPermission } = useAuth();
  const [showConfirm, setShowConfirm] = useState(false);

  const revokeMutation = useRevokePreviousWebhookSecret();

  if (
    !hasPermission("webhooks.admin") ||
    endpoint.archivedAt ||
    !endpoint.previousSecretExpiresAt
  ) {
    return null;
  }

  const handleRevoke = () => {
    revokeMutation.mutate(endpoint.id, {
      onSettled: () => setShowConfirm(false),
    });
  };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setShowConfirm(true)}
        isLoading={revokeMutation.isPending}
      >
        Revoke Previous Secret
      </Button>
      <ConfirmationModal
        show={showConfirm}
        handleHide={() => setShowConfirm(false)}
        handleConfirm={handleRevoke}
        title="Revoke Previous Signing Secret"
        body={`The previous secret signs deliveries until ${formatDateTime(endpoint.previousSecretExpiresAt)}. Revoke it now? Receivers still verifying with it will start rejecting deliveries at once.`}
        confirmButtonText={revokeMutation.isPending ? "Revoking..." : "Revoke"}
      />
    </>
  );
};

export default RevokePreviousSecretButton;
