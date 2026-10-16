import useRevokePreviousIntegrationSecret from "../../api/useRevokePreviousIntegrationSecret";
import { Button, ConfirmationModal } from "@kosmeo-ui/react";
import type { Integration } from "../../api/types";
import { useState } from "react";

const RevokePreviousIntegrationSecretButton = ({
  integration,
}: {
  integration: Integration;
}) => {
  const [confirming, setConfirming] = useState(false);
  const revokeMutation = useRevokePreviousIntegrationSecret();

  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
        End Overlap Now
      </Button>
      <ConfirmationModal
        show={confirming}
        handleHide={() => setConfirming(false)}
        handleConfirm={() =>
          revokeMutation.mutate(integration.id, {
            onSuccess: () => setConfirming(false),
          })
        }
        title="End the secret overlap?"
        body="The previous secret stops working now. The external party can no longer get a token with it."
        confirmButtonText="End Overlap"
        isLoading={revokeMutation.isPending}
      />
    </>
  );
};

export default RevokePreviousIntegrationSecretButton;
