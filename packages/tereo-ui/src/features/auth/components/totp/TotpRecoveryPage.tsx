import useVerifyRecoveryCode from "../../api/totp/useVerifyRecoveryCode";
import { AuthPage, Button, Alert, Input, Col } from "@kosmeo-ui/react";
import { useSearchParams, Link } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import { SessionExpired } from "../SessionExpired";
import { flowSearch } from "../../api/oauthParams";
import {
  isExpiredFlowError,
  oauthErrorMessage,
} from "../../api/oauthErrorMessage";

export const TotpRecoveryPage = () => {
  const [searchParams] = useSearchParams();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sessionToken = searchParams.get("session") || "";

  const { mutate, isPending } = useVerifyRecoveryCode();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const urlError = searchParams.get("error");
    const errorDescription = searchParams.get("error_description");
    if (urlError) {
      setError(errorDescription || urlError);
    }
  }, [searchParams]);

  if (!sessionToken) return <SessionExpired />;
  if (expired) return <SessionExpired message={expired} />;

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.toUpperCase();
    setCode(value);
    setError(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const normalizedCode = code.replace(/[-\s]/g, "");
    if (normalizedCode.length !== 12) {
      setError("Please enter a valid recovery code");
      return;
    }

    mutate(
      { sessionToken, recoveryCode: normalizedCode },
      {
        onError: (err) => {
          const message = oauthErrorMessage(err, "Verification failed");
          if (isExpiredFlowError(err)) {
            setExpired(message);
            return;
          }
          setError(message);
          setCode("");
          inputRef.current?.focus();
        },
      }
    );
  };

  return (
    <AuthPage
      title="Recovery Code"
      subtitle="Enter one of your backup recovery codes"
      footer={
        <Link to={`/login/2fa?${flowSearch(sessionToken, searchParams)}`}>
          Use authenticator app instead
        </Link>
      }
    >
      <Col>
        {error && <Alert variant="danger">{error}</Alert>}
        <Alert variant="warning">
          Each recovery code can only be used once. After using this code, it
          will be invalidated.
        </Alert>
        <form onSubmit={handleSubmit}>
          <Col>
            <Input
              ref={inputRef}
              label="Recovery Code"
              name="recovery_code"
              type="text"
              value={code}
              onChange={handleCodeChange}
              placeholder="XXXX-XXXX-XXXX"
            />

            <Button type="submit" fullWidth disabled={isPending}>
              {isPending ? "Verifying..." : "Use Recovery Code"}
            </Button>
          </Col>
        </form>
      </Col>
    </AuthPage>
  );
};
