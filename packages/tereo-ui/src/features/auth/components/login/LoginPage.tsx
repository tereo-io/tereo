import useUpstreamProviders from "../../api/upstream/useUpstreamProviders";
import { upstreamErrorMessage } from "../../api/upstream/upstreamErrors";
import { AuthPage, Alert, Button, Input, Col } from "@kosmeo-ui/react";
import { upstreamStartUrl } from "../../api/upstream/upstreamUrls";
import { oauthErrorMessage } from "../../api/oauthErrorMessage";
import { pickOAuthParams } from "../../api/oauthParams";
import { useSearchParams } from "react-router-dom";
import { redirectTo } from "../../api/redirectTo";
import useLogin from "../../api/login/useLogin";
import { BackToSignIn } from "../BackToSignIn";
import { useState, useEffect } from "react";
import { isAxiosError } from "axios";
import "./styles.css";

export const LoginPage = () => {
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { mutate, isPending } = useLogin();
  const { data: providers } = useUpstreamProviders();

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
      <AuthPage title="Tereo">
        <Col>
          <Alert variant="danger">
            Invalid request. Please start the login process from the
            application.
          </Alert>
          <BackToSignIn />
        </Col>
      </AuthPage>
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

  return (
    <AuthPage title="Tereo" subtitle="Sign in to continue">
      <Col>
        {error && <Alert variant="danger">{error}</Alert>}
        {providers && providers.length > 0 && (
          <>
            {providers.map((provider) => (
              <Button
                key={provider.slug}
                variant="secondary"
                fullWidth
                onClick={() =>
                  redirectTo(upstreamStartUrl(provider.slug, oauthParams))
                }
              >
                Sign in with {provider.displayName}
              </Button>
            ))}
            <div className="t-login-divider">or</div>
          </>
        )}
        <form onSubmit={handleSubmit}>
          <Col>
            <Input
              label="Email"
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              autoComplete="email"
            />

            <Input
              label="Password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />

            <Button type="submit" fullWidth disabled={isPending}>
              {isPending ? "Signing In..." : "Sign In"}
            </Button>
          </Col>
        </form>
      </Col>
    </AuthPage>
  );
};
