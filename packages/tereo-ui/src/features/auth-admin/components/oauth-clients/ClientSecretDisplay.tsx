import { Alert, Col, DetailField, SecretDisplay } from "@kosmeo-ui/react";
import { faExclamationTriangle } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

interface ClientSecretDisplayProps {
  clientId: string;
  clientSecret: string;
}

export const ClientSecretDisplay = ({
  clientId,
  clientSecret,
}: ClientSecretDisplayProps) => {
  return (
    <Col size="md">
      <Alert variant="warning">
        <FontAwesomeIcon icon={faExclamationTriangle} />
        <span>
          Save these credentials now! The client secret will not be shown again.
        </span>
      </Alert>

      <DetailField
        label="Client ID"
        value={<SecretDisplay value={clientId} />}
      />

      <DetailField
        label="Client Secret"
        value={<SecretDisplay value={clientSecret} revealable />}
      />
    </Col>
  );
};
