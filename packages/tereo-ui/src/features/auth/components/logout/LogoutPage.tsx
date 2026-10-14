import useConfirmLogout from "../../api/logout/useConfirmLogout";
import useLogoutDetails from "../../api/logout/useLogoutDetails";
import { oauthErrorMessage } from "../../api/oauthErrorMessage";
import { isNavigableUrl } from "../../api/redirectTo";
import { useSearchParams } from "react-router-dom";
import { BackToSignIn } from "../BackToSignIn";
import { useState } from "react";
import {
  Alert,
  AuthPage,
  Button,
  Centered,
  Col,
  FormActions,
  Spinner,
} from "@kosmeo-ui/react";

/**
 * Sign-out confirmation. Core sends the browser here when a client asks to
 * end the session without an id_token_hint, which any site could do; the
 * session ends only if the user confirms.
 */
export const LogoutPage = () => {
  const [searchParams] = useSearchParams();
  const [signedOut, setSignedOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clientId = searchParams.get("client_id") || "";
  const confirmToken = searchParams.get("confirm_token") || "";
  const request = clientId && confirmToken ? { clientId, confirmToken } : null;

  const {
    data: details,
    isLoading,
    error: fetchError,
  } = useLogoutDetails(request);
  const { mutate, isPending } = useConfirmLogout();

  if (signedOut !== null) {
    return (
      <AuthPage title="Signed out">
        <Col>
          <Alert variant="success">You have been signed out.</Alert>
          <BackToSignIn href={signedOut} />
        </Col>
      </AuthPage>
    );
  }

  if (!request || fetchError) {
    return (
      <AuthPage title="Sign out">
        <Col>
          <Alert variant="danger">
            {request
              ? oauthErrorMessage(fetchError, "This sign-out link is invalid.")
              : "This sign-out link is invalid."}
          </Alert>
          <BackToSignIn />
        </Col>
      </AuthPage>
    );
  }

  if (isLoading || !details) {
    return (
      <AuthPage title="Sign out">
        <Centered>
          <Spinner size="lg" />
        </Centered>
      </AuthPage>
    );
  }

  const handleConfirm = () => {
    setError(null);
    mutate(
      {
        ...request,
        postLogoutRedirectUri:
          searchParams.get("post_logout_redirect_uri") || undefined,
        state: searchParams.get("state") || undefined,
      },
      {
        onSuccess: (data) => {
          if (data.redirect_url && isNavigableUrl(data.redirect_url)) {
            window.location.assign(data.redirect_url);
          } else setSignedOut(data.sign_in_url);
        },
        onError: (err) => setError(oauthErrorMessage(err, "Sign-out failed")),
      }
    );
  };

  return (
    <AuthPage
      title="Sign out"
      subtitle={
        <>
          Sign out of <strong>{details.client_name}</strong>?
        </>
      }
    >
      <Col>
        {error && <Alert variant="danger">{error}</Alert>}
        <FormActions align="fill">
          <Button
            variant="secondary"
            onClick={() => window.location.assign(details.sign_in_url)}
            disabled={isPending}
          >
            Stay signed in
          </Button>
          <Button onClick={handleConfirm} disabled={isPending}>
            {isPending ? "Signing out..." : "Sign out"}
          </Button>
        </FormActions>
      </Col>
    </AuthPage>
  );
};
