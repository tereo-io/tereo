import useOrgSelectSession from "../../api/org-select/useOrgSelectSession";
import useSubmitOrgSelect from "../../api/org-select/useSubmitOrgSelect";
import { useSearchParams } from "react-router-dom";
import { SessionExpired } from "../SessionExpired";
import { useState } from "react";
import "./styles.css";
import {
  isExpiredFlowError,
  oauthErrorMessage,
} from "../../api/oauthErrorMessage";
import {
  AuthPage,
  Button,
  Alert,
  Spinner,
  Centered,
  Col,
} from "@kosmeo-ui/react";

export const OrgSelectPage = () => {
  const [searchParams] = useSearchParams();
  const sessionToken = searchParams.get("session") || null;
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState<string | null>(null);

  const {
    data: session,
    isLoading,
    isError,
    error: fetchError,
  } = useOrgSelectSession(sessionToken);

  const { mutate: submitOrgSelect, isPending } = useSubmitOrgSelect();

  if (!sessionToken) return <SessionExpired />;
  if (expired) return <SessionExpired message={expired} />;

  if (isLoading) {
    return (
      <AuthPage title="Tereo">
        <Centered>
          <Spinner size="lg" />
        </Centered>
      </AuthPage>
    );
  }

  if (isError || !session) {
    return (
      <SessionExpired
        message={oauthErrorMessage(
          fetchError,
          "Session is invalid or expired. Please login again."
        )}
      />
    );
  }

  const handleSelectOrg = (organizationId: string) => {
    setError(null);
    submitOrgSelect(
      { session_token: sessionToken, organization_id: organizationId },
      {
        onError: (err) => {
          const message = oauthErrorMessage(
            err,
            "Failed to select organization"
          );
          if (isExpiredFlowError(err)) setExpired(message);
          else setError(message);
        },
      }
    );
  };

  return (
    <AuthPage title="Tereo" subtitle="Select an organization to continue">
      <Col>
        <div className="t-org-select-info">
          <div className="t-org-select-user">
            {session.user.name || session.user.email}
          </div>
          <div className="t-org-select-app">
            Signing in to {session.client.name}
          </div>
        </div>
        {error && <Alert variant="danger">{error}</Alert>}
        <Col size="sm">
          {session.organizations.map((org) => (
            <Button
              key={org.id}
              variant="light"
              fullWidth
              onClick={() => handleSelectOrg(org.id)}
              disabled={isPending}
            >
              <div className="t-org-select-card">
                <span className="t-org-select-card-name">{org.name}</span>
                <span className="t-org-select-card-slug">{org.slug}</span>
              </div>
            </Button>
          ))}
        </Col>
      </Col>
    </AuthPage>
  );
};
