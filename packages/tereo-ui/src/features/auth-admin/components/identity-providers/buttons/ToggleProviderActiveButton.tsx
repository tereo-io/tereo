import useSetProviderActive from "@/features/auth-admin/api/identity-providers/useSetProviderActive";
import type { IdentityProvider } from "@/features/auth-admin/api/identity-providers/types";
import { Button, ConfirmationModal } from "@kosmeo-ui/react";
import { useState } from "react";

interface ToggleProviderActiveButtonProps {
  provider: IdentityProvider;
}

const ToggleProviderActiveButton = ({
  provider,
}: ToggleProviderActiveButtonProps) => {
  const [showModal, setShowModal] = useState(false);
  const mutation = useSetProviderActive();

  const handleConfirm = () =>
    mutation.mutate(
      { id: provider.id, active: !provider.isActive },
      { onSettled: () => setShowModal(false) }
    );

  return (
    <>
      <Button
        variant={provider.isActive ? "danger" : "secondary"}
        size="sm"
        onClick={() => setShowModal(true)}
      >
        {provider.isActive ? "Deactivate" : "Activate"}
      </Button>
      <ConfirmationModal
        show={showModal}
        handleHide={() => setShowModal(false)}
        handleConfirm={handleConfirm}
        title={provider.isActive ? "Deactivate Provider" : "Activate Provider"}
        body={
          provider.isActive
            ? `Deactivate "${provider.displayName}"? Its users can no longer sign in through it, and its button leaves the login page.`
            : `Activate "${provider.displayName}"? Its button returns to the login page.`
        }
        confirmButtonText={mutation.isPending ? "Saving..." : "Confirm"}
      />
    </>
  );
};

export default ToggleProviderActiveButton;
