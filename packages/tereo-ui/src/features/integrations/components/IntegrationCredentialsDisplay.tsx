import { Alert, Col, DetailField, SecretDisplay } from "@kosmeo-ui/react";
import type { IntegrationCredentials } from "../api/types";
import env from "@/lib/env";

export const IntegrationCredentialsDisplay = ({
  credentials,
}: {
  credentials: IntegrationCredentials;
}) => (
  <Col size="md">
    <Alert variant="warning" heading="Copy the secret now">
      This is the only time the client secret is shown. Core stores only its
      hash: if it is lost, regenerate it.
    </Alert>
    <DetailField
      label="Client ID"
      value={<SecretDisplay value={credentials.clientId} />}
    />
    <DetailField
      label="Client secret"
      value={<SecretDisplay value={credentials.clientSecret} revealable />}
    />
    <DetailField
      label="Core URL"
      value={<SecretDisplay value={env.CORE_URL} />}
    />
    <p className="v-help-text">
      The external party requests tokens from core with the client credentials
      grant, using these values.
    </p>
  </Col>
);
