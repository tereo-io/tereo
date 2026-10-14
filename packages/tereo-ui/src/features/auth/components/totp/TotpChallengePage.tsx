import { AuthPage, Button, Alert, Input, Col } from "@kosmeo-ui/react";
import useVerifyTotp from "../../api/totp/useVerifyTotp";
import { useSearchParams, Link } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import { SessionExpired } from "../SessionExpired";
import { flowSearch } from "../../api/oauthParams";
import {
  isExpiredFlowError,
  oauthErrorMessage,
} from "../../api/oauthErrorMessage";

export const TotpChallengePage = () => {
  const [searchParams] = useSearchParams();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sessionToken = searchParams.get("session") || "";

  const { mutate, isPending } = useVerifyTotp();

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
    const value = e.target.value.replace(/\D/g, "").slice(0, 6);
    setCode(value);
    setError(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (code.length !== 6) {
      setError("Please enter a 6-digit code");
      return;
    }

    mutate(
      { sessionToken, totpCode: code },
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
      title="Two-Factor Authentication"
      subtitle="Enter the 6-digit code from your authenticator app"
      footer={
        <Link
          to={`/login/2fa/recovery?${flowSearch(sessionToken, searchParams)}`}
        >
          Use a recovery code instead
        </Link>
      }
    >
      <Col>
        {error && <Alert variant="danger">{error}</Alert>}

        <form onSubmit={handleSubmit}>
          <Col>
            <Input
              ref={inputRef}
              label="Verification Code"
              name="totp_code"
              type="text"
              autoComplete="one-time-code"
              value={code}
              onChange={handleCodeChange}
              placeholder="000000"
            />

            <Button
              type="submit"
              fullWidth
              disabled={code.length !== 6 || isPending}
            >
              {isPending ? "Verifying..." : "Verify"}
            </Button>
          </Col>
        </form>
      </Col>
    </AuthPage>
  );
};
