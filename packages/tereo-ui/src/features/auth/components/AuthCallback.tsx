import { Alert, AuthPage, Centered, Col, Spinner } from "@kosmeo-ui/react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { clearPKCE, takePostLoginPath } from "@/lib/auth/pkce";
import { oauthErrorMessage } from "../api/oauthErrorMessage";
import useExchangeToken from "@/lib/auth/useExchangeToken";
import { useEffect, useRef, useState } from "react";
import { BackToSignIn } from "./BackToSignIn";

export const AuthCallback = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const hasExchanged = useRef(false);

  const { mutateAsync } = useExchangeToken();

  useEffect(() => {
    // The code is single-use: StrictMode's second run must not resend it.
    if (hasExchanged.current) return;
    hasExchanged.current = true;

    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const errorParam = searchParams.get("error");

    if (errorParam) {
      clearPKCE();
      takePostLoginPath();
      setError(searchParams.get("error_description") || errorParam);
      return;
    }
    if (!code || !state) {
      setError("Missing authorization code or state parameter");
      return;
    }

    mutateAsync({ code, state })
      .then(() => navigate(takePostLoginPath() ?? "/", { replace: true }))
      .catch((err: unknown) =>
        setError(oauthErrorMessage(err, "Token exchange failed"))
      );
  }, [searchParams, mutateAsync, navigate]);

  if (error) {
    return (
      <AuthPage title="Sign-in failed">
        <Col>
          <Alert variant="danger">{error}</Alert>
          <BackToSignIn />
        </Col>
      </AuthPage>
    );
  }

  return (
    <Centered>
      <Spinner size="lg" />
      <p>Signing in...</p>
    </Centered>
  );
};
