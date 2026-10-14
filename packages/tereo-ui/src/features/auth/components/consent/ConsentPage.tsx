import useConsentDetails from "@/features/auth/api/consent/useConsentDetails";
import useSubmitConsent from "@/features/auth/api/consent/useSubmitConsent";
import { useSearchParams } from "react-router-dom";
import { SessionExpired } from "../SessionExpired";
import { BackToSignIn } from "../BackToSignIn";
import { useState } from "react";
import {
  isExpiredFlowError,
  oauthErrorMessage,
} from "../../api/oauthErrorMessage";
import {
  AuthPage,
  Button,
  Alert,
  Col,
  Spinner,
  Centered,
  FormActions,
  ListCard,
} from "@kosmeo-ui/react";

const SCOPE_LABELS: Record<string, { name: string; description: string }> = {
  openid: {
    name: "OpenID Connect",
    description: "Verify your identity",
  },
  profile: {
    name: "Profile Information",
    description: "Access your name and profile details",
  },
  email: {
    name: "Email Address",
    description: "Access your email address",
  },
  offline_access: {
    name: "Offline Access",
    description: "Stay signed in and refresh your session",
  },
};

export const ConsentPage = () => {
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState<string | null>(null);

  const sessionToken = searchParams.get("session") || "";

  const {
    data: consentDetails,
    isLoading,
    error: fetchError,
  } = useConsentDetails(sessionToken || null);

  const { mutate, isPending } = useSubmitConsent();

  if (!sessionToken) return <SessionExpired width="wide" />;
  if (expired) return <SessionExpired message={expired} width="wide" />;

  if (isLoading) {
    return (
      <AuthPage title="Authorization Request" width="wide">
        <Centered>
          <Spinner size="lg" />
          <p>Loading...</p>
        </Centered>
      </AuthPage>
    );
  }

  if (fetchError || !consentDetails) {
    return (
      <AuthPage title="Error" width="wide">
        <Alert variant="danger">
          {oauthErrorMessage(
            fetchError,
            "Failed to load consent details. Please try again."
          )}
        </Alert>
        <FormActions align="right">
          <BackToSignIn />
        </FormActions>
      </AuthPage>
    );
  }

  const handleDecision = (approved: boolean) => {
    setError(null);
    mutate(
      { sessionToken, approved },
      {
        onError: (err) => {
          const message = oauthErrorMessage(err, "Consent submission failed");
          if (isExpiredFlowError(err)) setExpired(message);
          else setError(message);
        },
      }
    );
  };

  const getScopeDisplay = (scope: {
    name: string;
    description: string | null;
  }) => {
    const predefined = SCOPE_LABELS[scope.name];
    if (predefined) {
      return predefined;
    }
    return {
      name: scope.name,
      description: scope.description || `Access to ${scope.name}`,
    };
  };

  return (
    <AuthPage
      title="Authorization Request"
      subtitle={
        <>
          <strong>{consentDetails.clientName}</strong> is requesting access to
          your account
        </>
      }
      width="wide"
      footer="By clicking Allow, you authorize this application to access your information as described above."
    >
      <Col>
        {error && <Alert variant="danger">{error}</Alert>}

        <Alert variant="primary">
          Signed in as{" "}
          <strong>
            {consentDetails.user.name || consentDetails.user.email}
          </strong>
        </Alert>

        <ListCard
          listTitle="This application will be able to:"
          items={consentDetails.scopes.map((scope) => {
            const display = getScopeDisplay(scope);
            return { label: display.name, value: display.description };
          })}
        />

        <FormActions align="fill">
          <Button
            variant="secondary"
            onClick={() => handleDecision(false)}
            disabled={isPending}
          >
            Deny
          </Button>
          <Button onClick={() => handleDecision(true)} disabled={isPending}>
            {isPending ? "Processing..." : "Allow"}
          </Button>
        </FormActions>
      </Col>
    </AuthPage>
  );
};
