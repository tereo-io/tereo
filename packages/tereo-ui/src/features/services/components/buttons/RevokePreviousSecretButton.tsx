import useRevokePreviousSecret from "../../api/useRevokePreviousSecret";
import { Button, ConfirmationModal } from "@kosmeo-ui/react";
import type { Service } from "../../api/types";
import { useState } from "react";

const RevokePreviousSecretButton = ({ service }: { service: Service }) => {
  const [confirming, setConfirming] = useState(false);
  const revokeMutation = useRevokePreviousSecret();

  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
        End Overlap Now
      </Button>
      <ConfirmationModal
        show={confirming}
        handleHide={() => setConfirming(false)}
        handleConfirm={() =>
          revokeMutation.mutate(service.id, {
            onSuccess: () => setConfirming(false),
          })
        }
        title="End the secret overlap?"
        body="The previous secret stops working now. Any copy of the service still using it can no longer get a token."
        confirmButtonText="End Overlap"
        isLoading={revokeMutation.isPending}
      />
    </>
  );
};

export default RevokePreviousSecretButton;
