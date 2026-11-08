import { Alert, Button, Input, Col } from "@kosmeo-ui/react";
import { BrandedAuthPage } from "@/features/auth/branding";
import type { FormEvent } from "react";
import "./styles.css";

interface Props {
  headline: string | null;
  subtitle: string | null;
  notice: string | null;
  signInLabel: string | null;
  providers: { slug: string; displayName: string }[];
  error: string | null;
  email: string;
  password: string;
  pending: boolean;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
  onProvider: (slug: string) => void;
}

/** The sign-in form without its data hooks, so the preview can render it too. */
export const LoginFormView = ({
  headline,
  subtitle,
  notice,
  signInLabel,
  providers,
  error,
  email,
  password,
  pending,
  onEmail,
  onPassword,
  onSubmit,
  onProvider,
}: Props) => (
  <BrandedAuthPage
    title={headline ?? undefined}
    subtitle={subtitle ?? "Sign in to continue"}
  >
    <Col>
      {notice && <Alert variant="primary">{notice}</Alert>}
      {error && <Alert variant="danger">{error}</Alert>}
      {providers.length > 0 && (
        <>
          {providers.map((provider) => (
            <Button
              key={provider.slug}
              variant="secondary"
              fullWidth
              onClick={() => onProvider(provider.slug)}
            >
              Sign in with {provider.displayName}
            </Button>
          ))}
          <div className="t-login-divider">or</div>
        </>
      )}
      <form onSubmit={onSubmit}>
        <Col>
          <Input
            label="Email"
            name="email"
            type="email"
            value={email}
            onChange={(e) => onEmail(e.target.value)}
            required
            autoFocus
            autoComplete="email"
          />

          <Input
            label="Password"
            name="password"
            type="password"
            value={password}
            onChange={(e) => onPassword(e.target.value)}
            required
            autoComplete="current-password"
          />

          <Button type="submit" fullWidth disabled={pending}>
            {pending ? "Signing In..." : (signInLabel ?? "Sign In")}
          </Button>
        </Col>
      </form>
    </Col>
  </BrandedAuthPage>
);
