import { Alert, Col, DetailField, SecretDisplay } from "@kosmeo-ui/react";
import type { ServiceCredentials } from "../api/types";
import env from "@/lib/env";

interface ServiceCredentialsDisplayProps {
  credentials: ServiceCredentials;
}

export const ServiceCredentialsDisplay = ({
  credentials,
}: ServiceCredentialsDisplayProps) => (
  <Col size="md">
    <Alert variant="warning" heading="Copy the secret now">
      This is the only time the client secret is shown. Core stores only its
      hash: if it is lost, regenerate it.
    </Alert>
    <DetailField
      label="Client ID (CORE_CLIENT_ID)"
      value={<SecretDisplay value={credentials.clientId} />}
    />
    <DetailField
      label="Client secret (CORE_CLIENT_SECRET)"
      value={<SecretDisplay value={credentials.clientSecret} revealable />}
    />
    <DetailField
      label="Core URL (CORE_URL)"
      value={<SecretDisplay value={env.CORE_URL} />}
    />
    <p className="v-help-text">
      Configure the service with these three variables. A service added here
      gets credentials only; app services that own permissions, roles, buckets
      or event types are declared in provisioning documents.
    </p>
  </Col>
);
