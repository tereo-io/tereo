import { Alert, Button, Col, FormActions, Input } from "@kosmeo-ui/react";
import { BrandedAuthPage, LoginFormView } from "@/features/auth";

export type PreviewPage = "login" | "2fa" | "org-select" | "consent" | "logout";

export const PREVIEW_PAGES: { value: PreviewPage; label: string }[] = [
  { value: "login", label: "Login" },
  { value: "2fa", label: "2FA" },
  { value: "org-select", label: "Org select" },
  { value: "consent", label: "Consent" },
  { value: "logout", label: "Logout" },
];

export interface PreviewText {
  headline: string | null;
  subtitle: string | null;
  notice: string | null;
  signInLabel: string | null;
}

const noop = () => {};

/**
 * Static stand-ins for each sign-in step: the real shell with the page's stock
 * heading and a representative body, none of the pages' data hooks.
 */
export const PreviewBody = ({
  page,
  text,
}: {
  page: PreviewPage;
  text: PreviewText;
}) => {
  switch (page) {
    case "login":
      return (
        <LoginFormView
          headline={text.headline}
          subtitle={text.subtitle}
          notice={text.notice}
          signInLabel={text.signInLabel}
          providers={[{ slug: "example", displayName: "Example" }]}
          error={null}
          email=""
          password=""
          pending={false}
          onEmail={noop}
          onPassword={noop}
          onSubmit={(e) => e.preventDefault()}
          onProvider={noop}
        />
      );
    case "2fa":
      return (
        <BrandedAuthPage
          title="Two-Factor Authentication"
          subtitle="Enter the 6-digit code from your authenticator app"
          footer="Use a recovery code instead"
        >
          <Col>
            <Input
              label="Verification Code"
              placeholder="000000"
              readOnly
              value=""
            />
            <Button fullWidth disabled>
              Verify
            </Button>
          </Col>
        </BrandedAuthPage>
      );
    case "org-select":
      return (
        <BrandedAuthPage subtitle="Select an organization to continue">
          <Col>
            <Col size="sm">
              <Button variant="light" fullWidth>
                Acme Inc
              </Button>
              <Button variant="light" fullWidth>
                Globex
              </Button>
            </Col>
          </Col>
        </BrandedAuthPage>
      );
    case "consent":
      return (
        <BrandedAuthPage
          title="Authorization Request"
          subtitle={
            <>
              <strong>Example app</strong> is requesting access to your account
            </>
          }
          width="wide"
          footer="By clicking Allow, you authorize this application to access your information as described above."
        >
          <Col>
            <Alert variant="primary">
              Signed in as <strong>Jane Doe</strong>
            </Alert>
            <FormActions align="fill">
              <Button variant="secondary">Deny</Button>
              <Button>Allow</Button>
            </FormActions>
          </Col>
        </BrandedAuthPage>
      );
    case "logout":
      return (
        <BrandedAuthPage
          title="Sign out"
          subtitle={
            <>
              Sign out of <strong>Example app</strong>?
            </>
          }
        >
          <FormActions align="fill">
            <Button variant="secondary">Stay signed in</Button>
            <Button>Sign out</Button>
          </FormActions>
        </BrandedAuthPage>
      );
  }
};
