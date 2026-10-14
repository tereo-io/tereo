import { Alert, Col, DetailField, SecretDisplay } from "@kosmeo-ui/react";
import { faExclamationTriangle } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

interface WebhookSecretDisplayProps {
  url: string;
  signingSecret: string;
}

/**
 * Shown once, after create or rotate — every other read returns the secret
 * masked. Receivers verify `X-Webhook-Signature`
 * (`sha256=HMAC(secret, "<timestamp>.<body>")`) with it.
 */
export const WebhookSecretDisplay = ({
  url,
  signingSecret,
}: WebhookSecretDisplayProps) => {
  return (
    <Col size="md">
      <Alert variant="warning">
        <FontAwesomeIcon icon={faExclamationTriangle} />
        <span>Save this signing secret now! It will not be shown again.</span>
      </Alert>

      <DetailField label="Endpoint URL" value={<SecretDisplay value={url} />} />

      <DetailField
        label="Signing Secret"
        value={<SecretDisplay value={signingSecret} revealable />}
      />
    </Col>
  );
};
