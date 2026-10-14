import useUpdateIdentityProvider from "@/features/auth-admin/api/identity-providers/useUpdateIdentityProvider";
import { IdentityProviderForm } from "../forms/IdentityProviderForm";
import { Button, IconButton, Modal } from "@kosmeo-ui/react";
import { faEdit } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";
import type {
  IdentityProvider,
  UpdateIdentityProviderInput,
} from "@/features/auth-admin/api/identity-providers/types";

interface EditIdentityProviderButtonProps {
  provider: IdentityProvider;
}

const EditIdentityProviderButton = ({
  provider,
}: EditIdentityProviderButtonProps) => {
  const [showModal, setShowModal] = useState(false);
  const updateMutation = useUpdateIdentityProvider();

  return (
    <>
      <IconButton
        icon={faEdit}
        title="Edit"
        variant="secondary"
        size="sm"
        onClick={() => setShowModal(true)}
      />
      <Modal
        show={showModal}
        onClose={() => setShowModal(false)}
        title="Edit Identity Provider"
        size="lg"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={() => setShowModal(false)}
          >
            Cancel
          </Button>,
          <Button
            key="submit"
            type="submit"
            form="edit-identity-provider-form"
            isLoading={updateMutation.isPending}
          >
            Update Provider
          </Button>,
        ]}
      >
        <IdentityProviderForm
          formId="edit-identity-provider-form"
          provider={provider}
          onSubmit={(data) =>
            updateMutation.mutate(
              {
                id: provider.id,
                updateData: data as UpdateIdentityProviderInput,
              },
              { onSuccess: () => setShowModal(false) }
            )
          }
        />
      </Modal>
    </>
  );
};

export default EditIdentityProviderButton;
