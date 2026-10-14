import useUpstreamProviders from "../../api/upstream/useUpstreamProviders";
import { AuthPage, Alert, Button, Col, Spinner } from "@kosmeo-ui/react";
import { upstreamStartUrl } from "../../api/upstream/upstreamUrls";
import { useSearchParams } from "react-router-dom";
import { SessionExpired } from "../SessionExpired";
import { redirectTo } from "../../api/redirectTo";
import { BackToSignIn } from "../BackToSignIn";

/**
 * Reached after a correct password for an SSO-only account that has no link to
 * its provider yet. The grant cookie is already set; connecting finishes the
 * sign-in.
 */
export const LinkRequiredPage = () => {
  const [searchParams] = useSearchParams();
  const grant = searchParams.get("grant") || "";
  const slug = searchParams.get("provider") || "";
  const { data: providers, isLoading } = useUpstreamProviders();

  if (!grant || !slug) return <SessionExpired />;

  if (isLoading) {
    return (
      <AuthPage title="Connect your account" subtitle="Please wait...">
        <Spinner size="lg" />
      </AuthPage>
    );
  }

  const provider = providers?.find((p) => p.slug === slug);
  const name = provider?.displayName ?? slug;

  return (
    <AuthPage
      title="Connect your account"
      subtitle={`Your organization signs in with ${name}`}
    >
      <Col>
        <Alert variant="warning">
          Your password was correct, but this account has to sign in through{" "}
          {name}. Connect it once and use {name} from now on.
        </Alert>
        <Button
          fullWidth
          disabled={!provider}
          onClick={() => redirectTo(upstreamStartUrl(slug, { grant }))}
        >
          Connect {name}
        </Button>
        {!provider && (
          <Alert variant="danger">
            {name} is not available right now. Ask an administrator.
          </Alert>
        )}
        <BackToSignIn />
      </Col>
    </AuthPage>
  );
};
