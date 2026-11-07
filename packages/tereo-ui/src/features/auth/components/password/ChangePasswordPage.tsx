import useForcedPasswordChange from "../../api/password/useForcedPasswordChange";
import { Alert, Button, Col, Input } from "@kosmeo-ui/react";
import { BrandedAuthPage } from "@/features/auth/branding";
import { pickOAuthParams } from "../../api/oauthParams";
import { useSearchParams } from "react-router-dom";
import { SessionExpired } from "../SessionExpired";
import { redirectTo } from "../../api/redirectTo";
import { useRef, useState } from "react";
import env from "@/lib/env";
import {
  isExpiredFlowError,
  oauthErrorMessage,
} from "../../api/oauthErrorMessage";

export const ChangePasswordPage = () => {
  const [searchParams] = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState<string | null>(null);
  // The grant is single-use: a second submit before the first settles would
  // be refused and show an error for a change that succeeded.
  const submitting = useRef(false);

  const changeGrant = searchParams.get("change_grant") || "";
  const clientId = searchParams.get("client_id") || "";
  const { mutate, isPending } = useForcedPasswordChange();

  if (!changeGrant || !clientId) return <SessionExpired />;
  if (expired) return <SessionExpired message={expired} />;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current) return;
    if (password !== confirm) {
      setError("The passwords do not match");
      return;
    }
    submitting.current = true;
    setError(null);
    mutate(
      { changeGrant, password },
      {
        // Restarts the original authorize request, whose PKCE challenge and
        // state the client still holds.
        onSuccess: () => {
          const params = new URLSearchParams({
            ...pickOAuthParams(searchParams),
            response_type: "code",
          });
          redirectTo(`${env.CORE_URL}/oauth/authorize?${params.toString()}`);
        },
        onError: (err) => {
          submitting.current = false;
          const message = oauthErrorMessage(
            err,
            "Could not change your password"
          );
          if (isExpiredFlowError(err)) setExpired(message);
          else setError(message);
        },
      }
    );
  };

  return (
    <BrandedAuthPage
      title="Choose a new password"
      subtitle="You must replace the password you were given before continuing"
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
            {isPending ? "Saving..." : "Change password"}
          </Button>
        </Col>
      </form>
    </BrandedAuthPage>
  );
};
