import useUpdateIntegration from "../../api/useUpdateIntegration";
import { Button, ConfirmationModal } from "@kosmeo-ui/react";
import type { Integration } from "../../api/types";
import { toast } from "react-toastify";
import { useState } from "react";

/** Deactivating asks first: the integration's tokens stop working at once. */
const ToggleIntegrationActiveButton = ({
  integration,
}: {
  integration: Integration;
}) => {
  const [confirming, setConfirming] = useState(false);
  const updateMutation = useUpdateIntegration();

  const setActive = (isActive: boolean) =>
    updateMutation.mutate(
      { id: integration.id, data: { isActive } },
      {
        onSuccess: () => {
          toast.success(
            isActive ? "Integration reactivated" : "Integration deactivated"
          );
          setConfirming(false);
        },
      }
    );

  if (!integration.isActive) {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setActive(true)}
        isLoading={updateMutation.isPending}
      >
        Reactivate
      </Button>
    );
  }

  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
        Deactivate
      </Button>
      <ConfirmationModal
        show={confirming}
        handleHide={() => setConfirming(false)}
        handleConfirm={() => setActive(false)}
        title={`Deactivate ${integration.name}?`}
        body="Its tokens are revoked at once and it cannot get new ones, so every call it makes to core fails until it is reactivated. Its roles and audiences are kept."
        confirmButtonText="Deactivate"
        isLoading={updateMutation.isPending}
      />
    </>
  );
};

export default ToggleIntegrationActiveButton;
