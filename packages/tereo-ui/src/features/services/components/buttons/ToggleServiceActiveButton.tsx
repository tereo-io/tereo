import { Button, ConfirmationModal } from "@kosmeo-ui/react";
import useUpdateService from "../../api/useUpdateService";
import type { Service } from "../../api/types";
import { toast } from "react-toastify";
import { useState } from "react";

/** Deactivating asks first: the service's tokens stop working at once. */
const ToggleServiceActiveButton = ({ service }: { service: Service }) => {
  const [confirming, setConfirming] = useState(false);
  const updateMutation = useUpdateService();

  const setActive = (isActive: boolean) =>
    updateMutation.mutate(
      { id: service.id, data: { isActive } },
      {
        onSuccess: () => {
          toast.success(
            isActive ? "Service reactivated" : "Service deactivated"
          );
          setConfirming(false);
        },
      }
    );

  if (!service.isActive) {
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
        title={`Deactivate ${service.name}?`}
        body="Its tokens are revoked at once and it cannot get new ones, so every call it makes to core fails until it is reactivated. Its declarations, buckets and approved access are kept."
        confirmButtonText="Deactivate"
        isLoading={updateMutation.isPending}
      />
    </>
  );
};

export default ToggleServiceActiveButton;
