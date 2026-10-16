import useRegenerateIntegrationSecret from "../../api/useRegenerateIntegrationSecret";
import { IntegrationCredentialsDisplay } from "../IntegrationCredentialsDisplay";
import { Alert, Button, Col, Modal } from "@kosmeo-ui/react";
import { toast } from "react-toastify";
import { useState } from "react";
import type {
  Integration,
  RegeneratedIntegrationSecret,
} from "../../api/types";

/** Asks first, then shows the new secret once. */
const RegenerateIntegrationSecretButton = ({
  integration,
}: {
  integration: Integration;
}) => {
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<RegeneratedIntegrationSecret | null>(
    null
  );
  const regenerateMutation = useRegenerateIntegrationSecret();

  const handleConfirm = () =>
    regenerateMutation.mutate(integration.id, {
      onSuccess: (data) => {
        setConfirming(false);
        setResult(data);
      },
    });

  const handleCancel = () => {
    // Closing mid-request would drop the observer and lose the new secret.
    if (regenerateMutation.isPending) return;
    setConfirming(false);
    regenerateMutation.reset();
  };

  const handleSaved = () => {
    setResult(null);
    regenerateMutation.reset();
    toast.success("Secret regenerated");
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
        Regenerate Secret
      </Button>

      <Modal
        show={confirming}
        onClose={handleCancel}
        title="Regenerate Secret"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={handleCancel}
            disabled={regenerateMutation.isPending}
          >
            Cancel
          </Button>,
          <Button
            key="confirm"
            onClick={handleConfirm}
            isLoading={regenerateMutation.isPending}
          >
            Regenerate
          </Button>,
        ]}
      >
        <p>
          A new client secret is generated for{" "}
          <strong>{integration.name}</strong> and shown once. The current secret
          keeps working for a while, so the external party can switch over; end
          the overlap from this page once they have.
        </p>
      </Modal>

      <Modal
        show={!!result}
        onClose={handleSaved}
        title="New Secret"
        footerButtons={[
          <Button key="close" onClick={handleSaved}>
            I have saved these credentials
          </Button>,
        ]}
      >
        {result && (
          <Col size="md">
            <IntegrationCredentialsDisplay credentials={result} />
            {result.previousSecretExpiresAt ? (
              <Alert variant="primary">
                The previous secret keeps working until{" "}
                {new Date(result.previousSecretExpiresAt).toLocaleString()}.
              </Alert>
            ) : (
              <Alert variant="danger">
                The previous secret has stopped working: core is configured with
                no overlap.
              </Alert>
            )}
          </Col>
        )}
      </Modal>
    </>
  );
};

export default RegenerateIntegrationSecretButton;
