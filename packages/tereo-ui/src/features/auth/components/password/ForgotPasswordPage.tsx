import useRequestPasswordReset from "../../api/password/useRequestPasswordReset";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Alert, Button, Col, Input } from "@kosmeo-ui/react";
import { BrandedAuthPage } from "@/features/auth/branding";
import { useState } from "react";

const TRY_AGAIN =
  "Too many attempts or the service is busy. Try again shortly.";

/**
 * The sign-in page this one was opened from, with its authorize request, as
 * the login page passed it in this tab's history; else `/`, which starts a
 * fresh sign-in.
 */
const backToSignIn = (state: unknown): string => {
  const search = (state as { loginSearch?: unknown } | null)?.loginSearch;
  return typeof search === "string" && search.startsWith("?")
    ? `/login${search}`
    : "/";
};

export const ForgotPasswordPage = () => {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const clientId = searchParams.get("client_id") ?? undefined;
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { mutate, isPending } = useRequestPasswordReset();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    mutate(
      { email, clientId },
      {
        onSuccess: () => setSent(true),
        onError: () => setError(TRY_AGAIN),
      }
    );
  };

  const back = (
    <Link className="v-link" to={backToSignIn(location.state)}>
      Back to sign in
    </Link>
  );

  if (sent) {
    return (
      <BrandedAuthPage title="Reset your password">
        <Col>
          <Alert variant="success">
            If an account exists for that address, we&apos;ve sent a link.
          </Alert>
          {back}
        </Col>
      </BrandedAuthPage>
    );
  }

  return (
    <BrandedAuthPage
      title="Reset your password"
      subtitle="Enter your email and we'll send you a link to choose a new password."
    >
      <form onSubmit={handleSubmit}>
        <Col>
          {error && <Alert variant="danger">{error}</Alert>}
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
          <Button type="submit" fullWidth disabled={isPending}>
            {isPending ? "Sending..." : "Send reset link"}
          </Button>
          {back}
        </Col>
      </form>
    </BrandedAuthPage>
  );
};
