import useInspectPasswordSetup from "../../api/password/useInspectPasswordSetup";
import { AuthPage, Alert, Button, Col, Input, Spinner } from "@kosmeo-ui/react";
import { oauthErrorMessage } from "../../api/oauthErrorMessage";
import useSetPassword from "../../api/password/useSetPassword";
import { useLocation, useNavigate } from "react-router-dom";
import { useMemo, useState } from "react";

const INVALID_LINK = "This link is no longer valid";

/** The link carries its token in the fragment, which never reaches server logs or Referer headers. */
const tokenFromHash = (hash: string): string =>
  new URLSearchParams(hash.replace(/^#/, "")).get("token") ?? "";

export const SetPasswordPage = () => {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const token = useMemo(() => tokenFromHash(hash), [hash]);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: details, isLoading, isError } = useInspectPasswordSetup(token);
  const { mutate, isPending } = useSetPassword();

  if (!token || isError) {
    return (
      <AuthPage title={INVALID_LINK}>
        <Alert variant="danger">
          Ask whoever invited you to send a new link.
        </Alert>
      </AuthPage>
    );
  }

  if (isLoading || !details) {
    return (
      <AuthPage title="Set your password" subtitle="Please wait...">
        <Spinner size="lg" />
      </AuthPage>
    );
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError("The passwords do not match");
      return;
    }
    setError(null);
    mutate(
      { token, password },
      {
        onSuccess: () =>
          navigate(`/login?login_hint=${encodeURIComponent(details.email)}`, {
            replace: true,
          }),
        onError: (err) => setError(oauthErrorMessage(err, INVALID_LINK)),
      }
    );
  };

  return (
    <AuthPage
      title="Set your password"
      subtitle={`Choose a password for ${details.email}`}
    >
      <form onSubmit={handleSubmit}>
        <Col>
          {error && <Alert variant="danger">{error}</Alert>}
          <Input
            label="New password"
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
            autoComplete="new-password"
          />
          <Input
            label="Confirm password"
            name="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            autoComplete="new-password"
          />
          <Button type="submit" fullWidth disabled={isPending}>
            {isPending ? "Saving..." : "Set password"}
          </Button>
        </Col>
      </form>
    </AuthPage>
  );
};
