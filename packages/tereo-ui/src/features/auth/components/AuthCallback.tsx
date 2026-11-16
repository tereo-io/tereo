import { Alert, Centered, Col, Spinner } from "@kosmeo-ui/react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { oauthErrorMessage } from "../api/oauthErrorMessage";
import { BrandedAuthPage } from "@/features/auth/branding";
import { useCompleteSignIn } from "@tereo-io/react";
import { useEffect, useRef, useState } from "react";
import { BackToSignIn } from "./BackToSignIn";

export const AuthCallback = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const hasExchanged = useRef(false);

  const { complete } = useCompleteSignIn();

  useEffect(() => {
    // StrictMode runs this effect twice; the result is handled once.
    if (hasExchanged.current) return;
    hasExchanged.current = true;

    complete(searchParams)
      .then(({ returnTo }) => navigate(returnTo ?? "/", { replace: true }))
      .catch((err: unknown) => {
        const errorParam = searchParams.get("error");
        if (errorParam) {
          setError(searchParams.get("error_description") || errorParam);
        } else if (!searchParams.get("code") || !searchParams.get("state")) {
          setError("Missing authorization code or state parameter");
        } else {
          setError(oauthErrorMessage(err, "Token exchange failed"));
        }
      });
  }, [searchParams, complete, navigate]);

  if (error) {
    return (
      <BrandedAuthPage title="Sign-in failed">
        <Col>
          <Alert variant="danger">{error}</Alert>
          <BackToSignIn />
        </Col>
      </BrandedAuthPage>
    );
  }

  return (
    <Centered>
      <Spinner size="lg" />
      <p>Signing in...</p>
    </Centered>
  );
};
