import usePasswordResetStatus from "../../api/password/usePasswordResetStatus";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import useUpstreamProviders from "../../api/upstream/useUpstreamProviders";
import { upstreamErrorMessage } from "../../api/upstream/upstreamErrors";
import { BrandedAuthPage, useBranding } from "@/features/auth/branding";
import { upstreamStartUrl } from "../../api/upstream/upstreamUrls";
import { oauthErrorMessage } from "../../api/oauthErrorMessage";
import { pickOAuthParams } from "../../api/oauthParams";
import { redirectTo } from "../../api/redirectTo";
import useLogin from "../../api/login/useLogin";
import { LoginFormView } from "./LoginFormView";
import { BackToSignIn } from "../BackToSignIn";
import { Alert, Col } from "@kosmeo-ui/react";
import { useState, useEffect } from "react";
import { isAxiosError } from "axios";

export const LoginPage = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const branding = useBranding();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { mutate, isPending } = useLogin();
  const { data: providers } = useUpstreamProviders();
  const { data: resetStatus } = usePasswordResetStatus();

  const oauthParams = pickOAuthParams(searchParams);

  useEffect(() => {
    const urlError = searchParams.get("error");
    const errorDescription = searchParams.get("error_description");
    if (urlError) {
      setError(upstreamErrorMessage(urlError) || errorDescription || urlError);
    }
  }, [searchParams]);

  if (!oauthParams.client_id) {
    return (
      <BrandedAuthPage>
        <Col>
          <Alert variant="danger">
            Invalid request. Please start the login process from the
            application.
          </Alert>
          <BackToSignIn />
        </Col>
      </BrandedAuthPage>
    );
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    mutate(
      { email, password, oauthParams },
      {
        onError: (err) => {
          // An SSO-only domain refuses the password; the way in is its provider.
          if (
            isAxiosError<{ error?: string; provider?: string }>(err) &&
            err.response?.data?.error === "sso_required" &&
            err.response.data.provider
          ) {
            redirectTo(
              upstreamStartUrl(err.response.data.provider, oauthParams)
            );
            return;
          }
          setError(oauthErrorMessage(err, "Login failed"));
        },
      }
    );
  };

  const forgotPasswordHref = `/forgot-password?client_id=${encodeURIComponent(
    oauthParams.client_id
  )}`;

  return (
    <LoginFormView
      headline={branding?.headline ?? null}
      subtitle={branding?.subtitle ?? null}
      notice={branding?.notice ?? null}
      signInLabel={branding?.signInLabel ?? null}
      providers={providers ?? []}
      error={error}
      email={email}
      password={password}
      pending={isPending}
      onEmail={setEmail}
      onPassword={setPassword}
      onSubmit={handleSubmit}
      forgotPasswordHref={resetStatus?.enabled ? forgotPasswordHref : undefined}
      onForgotPassword={() =>
        navigate(forgotPasswordHref, {
          state: { loginSearch: location.search },
        })
      }
      onProvider={(slug) => redirectTo(upstreamStartUrl(slug, oauthParams))}
    />
  );
};
