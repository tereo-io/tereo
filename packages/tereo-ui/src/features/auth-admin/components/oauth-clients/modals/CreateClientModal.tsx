import useCreateClient from "@/features/auth-admin/api/oauth-clients/useCreateClient";
import { ClientSecretDisplay } from "../ClientSecretDisplay";
import { Button, Modal } from "@kosmeo-ui/react";
import { ClientForm } from "../forms/ClientForm";
import { toast } from "react-toastify";
import { useState } from "react";
import {
  CreateClientInput,
  OAuthClientWithSecret,
} from "@/features/auth-admin/api/oauth-clients/types";

interface CreateClientModalProps {
  show: boolean;
  onCreate: () => void;
  onClose: () => void;
}

const CreateClientModal = (props: CreateClientModalProps) => {
  const [newClientWithSecret, setNewClientWithSecret] =
    useState<OAuthClientWithSecret | null>(null);

  const createMutation = useCreateClient();

  const handleCreate = (data: CreateClientInput) => {
    createMutation.mutate(data, {
      onSuccess: (createdClient) => {
        if (createdClient.clientSecret) {
          setNewClientWithSecret(createdClient);
        } else props.onCreate();
      },
    });
  };

  const handleSecretModalClose = () => {
    setNewClientWithSecret(null);
    toast.success("Client created successfully");
    props.onCreate();
  };

  return (
    <>
      <Modal
        show={props.show && !newClientWithSecret}
        onClose={props.onClose}
        title="Create OAuth Client"
        size="lg"
        footerButtons={[
          <Button key="cancel" variant="secondary" onClick={props.onClose}>
            Cancel
          </Button>,
          <Button
            key="submit"
            type="submit"
            form="create-client-form"
            isLoading={createMutation.isPending}
          >
            Create Client
          </Button>,
        ]}
      >
        <ClientForm
          formId="create-client-form"
          onSubmit={(data) => handleCreate(data as CreateClientInput)}
        />
      </Modal>

      <Modal
        show={!!newClientWithSecret}
        onClose={handleSecretModalClose}
        title="Client Created"
        footerButtons={[
          <Button key="close" onClick={handleSecretModalClose}>
            I have saved these credentials
          </Button>,
        ]}
      >
        {newClientWithSecret && (
          <ClientSecretDisplay
            clientId={newClientWithSecret.clientId}
            clientSecret={newClientWithSecret.clientSecret || ""}
          />
        )}
      </Modal>
    </>
  );
};

export default CreateClientModal;
