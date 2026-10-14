import useRegenerateServiceSecret from "../../api/useRegenerateServiceSecret";
import { ServiceCredentialsDisplay } from "../ServiceCredentialsDisplay";
import type { RegeneratedSecret, ServiceDetail } from "../../api/types";
import { Alert, Button, Col, Modal } from "@kosmeo-ui/react";
import formatHours from "../../formatHours";
import { toast } from "react-toastify";
import { useState } from "react";

/**
 * Asks first and explains the overlap, then shows the new secret once. The
 * overlap length is core's SERVICE_SECRET_OVERLAP_HOURS, from the service
 * detail's `settings`.
 */
const RegenerateServiceSecretButton = ({
  service,
}: {
  service: ServiceDetail;
}) => {
  const overlapHours = service.settings.secretOverlapHours;
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<RegeneratedSecret | null>(null);
  const regenerateMutation = useRegenerateServiceSecret();

  const handleConfirm = () =>
    regenerateMutation.mutate(service.id, {
      onSuccess: (data) => {
        setConfirming(false);
        setResult(data);
      },
    });

  const handleSaved = () => {
    setResult(null);
    toast.success("Secret regenerated");
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
        Regenerate Secret
      </Button>

      <Modal
        show={confirming}
        onClose={() => setConfirming(false)}
        title="Regenerate Secret"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={() => setConfirming(false)}
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
        <Col>
          <p>
            A new client secret is generated for <strong>{service.name}</strong>{" "}
            and shown once.
          </p>
          {overlapHours > 0 ? (
            <p>
              The current secret{" "}
              <strong>keeps working for {formatHours(overlapHours)}</strong>, so
              running copies keep calling core while you roll the new secret
              out. Once every copy uses the new one, end the overlap from this
              page.
            </p>
          ) : (
            <Alert variant="danger">
              Core is configured with no overlap: the current secret stops
              working the moment you regenerate, and every running copy fails
              until it has the new one.
            </Alert>
          )}
          {overlapHours > 0 &&
            service.previousSecretExpiresAt &&
            new Date(service.previousSecretExpiresAt) > new Date() && (
              <Alert variant="warning">
                An earlier overlap is still running. Regenerating now stops the
                older secret at once; only the current one gets the new overlap.
              </Alert>
            )}
        </Col>
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
            <ServiceCredentialsDisplay credentials={result} />
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

export default RegenerateServiceSecretButton;
