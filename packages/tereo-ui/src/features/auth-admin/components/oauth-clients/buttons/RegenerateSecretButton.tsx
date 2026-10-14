import useRegenerateClientSecret from "@/features/auth-admin/api/oauth-clients/useRegenerateClientSecret";
import { OAuthClient } from "@/features/auth-admin/api/oauth-clients/types";
import { ClientSecretDisplay } from "../ClientSecretDisplay";
import { Button, Modal } from "@kosmeo-ui/react";
import { toast } from "react-toastify";
import { useState } from "react";

interface RegenerateSecretButtonProps {
  client: OAuthClient;
}

const RegenerateSecretButton = ({ client }: RegenerateSecretButtonProps) => {
  const [showSecretModal, setShowSecretModal] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const regenerateMutation = useRegenerateClientSecret();

  const handleRegenerateSecret = () => {
    regenerateMutation.mutate(client.id, {
      onSuccess: (data) => {
        if (data.clientSecret) {
          setNewSecret(data.clientSecret);
          setShowSecretModal(true);
        }
      },
    });
  };

  const handleCloseSecretModal = () => {
    setShowSecretModal(false);
    setNewSecret(null);
    toast.success("Client secret regenerated");
  };

  if (client.clientType !== "confidential") return null;

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={handleRegenerateSecret}
        isLoading={regenerateMutation.isPending}
      >
        Regenerate Secret
      </Button>
      <Modal
        show={showSecretModal}
        onClose={handleCloseSecretModal}
        title="New Client Secret"
        footerButtons={[
          <Button key="close" onClick={handleCloseSecretModal}>
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

export default RegenerateSecretButton;
