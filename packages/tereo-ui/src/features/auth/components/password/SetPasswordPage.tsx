import useInspectPasswordSetup from "../../api/password/useInspectPasswordSetup";
import { Alert, Button, Col, Input, Spinner } from "@kosmeo-ui/react";
import { errorDescriptionOf, issuesOf } from "@/utils/apiErrors";
import useSetPassword from "../../api/password/useSetPassword";
import { useLocation, useNavigate } from "react-router-dom";
import { BrandedAuthPage } from "@/features/auth/branding";
import { useMemo, useState } from "react";
import { isAxiosError } from "axios";

const INVALID_LINK = "This link is no longer valid";
const TRY_AGAIN =
  "Too many attempts or the service is busy. Try again shortly.";

/** Rate limited or unavailable: the link may well still be good. */
const isTransient = (err: unknown): boolean =>
  isAxiosError(err) &&
  (err.response?.status === 429 || err.response?.status === 503);

/**
 * A 400 is about the password itself, so its rules are worth showing; a 429
 * or 503 is worth retrying; any other failure is the link's, and every miss
 * reads the same.
 */
const setPasswordErrorMessage = (err: unknown): string => {
  if (isTransient(err)) return TRY_AGAIN;
  if (!isAxiosError(err) || err.response?.status !== 400) return INVALID_LINK;
  const issues = issuesOf(err);
  return issues.length > 0
    ? issues.map((i) => i.message).join(" ")
    : errorDescriptionOf(err, INVALID_LINK);
};

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
  const [done, setDone] = useState(false);

  const {
    data: details,
    isLoading,
    isError,
    error: inspectError,
    refetch,
  } = useInspectPasswordSetup(token);
  const { mutate, isPending } = useSetPassword();

  if (done) {
    return (
      <BrandedAuthPage title="Password set">
        <Col>
          <Alert variant="success">
            Your password is set. You can now sign in.
          </Alert>
          <Button fullWidth onClick={() => navigate("/")}>
            Sign in
          </Button>
        </Col>
      </BrandedAuthPage>
    );
  }

  if (token && isError && isTransient(inspectError)) {
    return (
      <BrandedAuthPage title="Set your password">
        <Col>
          <Alert variant="warning">{TRY_AGAIN}</Alert>
          <Button fullWidth onClick={() => void refetch()}>
            Try again
          </Button>
        </Col>
      </BrandedAuthPage>
    );
  }

  if (!token || isError) {
    return (
      <BrandedAuthPage title={INVALID_LINK}>
        <Alert variant="danger">
          Ask whoever invited you to send a new link.
        </Alert>
      </BrandedAuthPage>
    );
  }

  if (isLoading || !details) {
    return (
      <BrandedAuthPage title="Set your password" subtitle="Please wait...">
        <Spinner size="lg" />
      </BrandedAuthPage>
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
        onSuccess: () => setDone(true),
        onError: (err) => setError(setPasswordErrorMessage(err)),
      }
    );
  };

  return (
    <BrandedAuthPage
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
    </BrandedAuthPage>
  );
};
