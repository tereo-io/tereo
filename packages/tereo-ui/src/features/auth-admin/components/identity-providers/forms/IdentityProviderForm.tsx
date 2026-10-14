import { useState } from "react";
import "../styles.css";
import type {
  IdentityProvider,
  CreateIdentityProviderInput,
  UpdateIdentityProviderInput,
} from "@/features/auth-admin/api/identity-providers/types";
import {
  Alert,
  Checkbox,
  Col,
  Form,
  Input,
  SecretDisplay,
} from "@kosmeo-ui/react";

interface IdentityProviderFormProps {
  provider?: IdentityProvider;
  onSubmit: (
    data: CreateIdentityProviderInput | UpdateIdentityProviderInput
  ) => void;
  formId?: string;
}

const DEFAULT_SCOPES = "openid email profile";

export const IdentityProviderForm = ({
  provider,
  onSubmit,
  formId,
}: IdentityProviderFormProps) => {
  const [slug, setSlug] = useState(provider?.slug || "");
  const [displayName, setDisplayName] = useState(provider?.displayName || "");
  const [issuer, setIssuer] = useState(provider?.issuer || "");
  const [clientId, setClientId] = useState(provider?.clientId || "");
  const [clientSecret, setClientSecret] = useState("");
  const [scopesText, setScopesText] = useState(
    provider ? provider.scopes.join(" ") : DEFAULT_SCOPES
  );
  const [countsAsMfa, setCountsAsMfa] = useState(
    provider?.countsAsMfa ?? false
  );

  // The stored secret is not sent to a new issuer or client: core needs a
  // new one with either change.
  const secretRequired =
    !provider || issuer !== provider.issuer || clientId !== provider.clientId;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const scopes = scopesText.split(/\s+/).filter(Boolean);

    if (provider) {
      const updates: UpdateIdentityProviderInput = {};
      if (slug !== provider.slug) updates.slug = slug;
      if (displayName !== provider.displayName)
        updates.displayName = displayName;
      if (issuer !== provider.issuer) updates.issuer = issuer;
      if (clientId !== provider.clientId) updates.clientId = clientId;
      // Left blank, the stored secret is kept.
      if (clientSecret) updates.clientSecret = clientSecret;
      if (scopesText !== provider.scopes.join(" ")) updates.scopes = scopes;
      if (countsAsMfa !== provider.countsAsMfa)
        updates.countsAsMfa = countsAsMfa;
      onSubmit(updates);
    } else {
      onSubmit({
        slug,
        displayName,
        kind: "oidc",
        issuer,
        clientId,
        clientSecret,
        scopes,
        countsAsMfa,
      });
    }
  };

  return (
    <Form onSubmit={handleSubmit} id={formId}>
      <Col>
        <Input
          label="Name"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          placeholder="e.g., Google"
        />
        <Input
          label="Slug"
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          required
          placeholder="e.g., google (used in the callback URL)"
        />
        {provider && (
          <div className="t-idp-callback">
            <span>Callback URL (register this at the provider)</span>
            <SecretDisplay value={provider.callbackUrl} />
          </div>
        )}
        <Input
          label="Issuer"
          type="url"
          value={issuer}
          onChange={(e) => setIssuer(e.target.value)}
          required
          placeholder="https://accounts.google.com"
        />
        <Input
          label="Client ID"
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          required
        />
        <Input
          label="Client Secret"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          required={secretRequired}
          autoComplete="off"
          placeholder={
            !provider
              ? undefined
              : secretRequired
                ? "Required when the issuer or client ID changes"
                : "Leave blank to keep the current secret"
          }
        />
        <Input
          label="Scopes"
          type="text"
          value={scopesText}
          onChange={(e) => setScopesText(e.target.value)}
          placeholder={DEFAULT_SCOPES}
        />
        <Checkbox
          id="counts-as-mfa"
          checked={countsAsMfa}
          onChange={(e) => setCountsAsMfa(e.target.checked)}
          label="Treat this provider's sign-in as two-factor"
          labelLocation="right"
        />
        {countsAsMfa && (
          <Alert variant="warning">
            Turning this on trusts the provider's own sign-in as two-factor and
            skips core's TOTP for its users. Only do it if the provider enforces
            MFA itself.
          </Alert>
        )}
      </Col>
    </Form>
  );
};
