import useUpdateClient from "@/features/auth-admin/api/oauth-clients/useUpdateClient";
import { Button, IconButton, Modal } from "@kosmeo-ui/react";
import { ClientSecretDisplay } from "../ClientSecretDisplay";
import { faEdit } from "@fortawesome/free-solid-svg-icons";
import { ClientForm } from "../forms/ClientForm";
import { useState } from "react";
import {
  UpdateClientInput,
  OAuthClient,
} from "@/features/auth-admin/api/oauth-clients/types";

interface EditClientButtonProps {
  client: OAuthClient;
}

const EditClientButton = ({ client }: EditClientButtonProps) => {
  const [showEditModal, setShowEditModal] = useState(false);
  // Set when switching to confidential gave the client its first secret,
  // which the response carries once.
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const updateMutation = useUpdateClient();

  const handleUpdate = (updateData: UpdateClientInput) => {
    updateMutation.mutate(
      { id: client.id, updateData },
      {
        onSuccess: (updated) => {
          setShowEditModal(false);
          if (updated.clientSecret) setNewSecret(updated.clientSecret);
        },
      }
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
        title="Edit Client"
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
            form="edit-client-form"
            isLoading={updateMutation.isPending}
          >
            Update Client
          </Button>,
        ]}
      >
        <ClientForm
          formId="edit-client-form"
          client={client}
          onSubmit={(data) => handleUpdate(data as UpdateClientInput)}
        />
      </Modal>
      <Modal
        show={!!newSecret}
        onClose={() => setNewSecret(null)}
        title="Client Secret"
        footerButtons={[
          <Button key="close" onClick={() => setNewSecret(null)}>
            I have saved these credentials
          </Button>,
        ]}
      >
        {newSecret && (
          <ClientSecretDisplay
            clientId={client.clientId}
            clientSecret={newSecret}
          />
        )}
      </Modal>
    </>
  );
};

export default EditClientButton;
