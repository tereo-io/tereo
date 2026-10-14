import { useState } from "react";
import type {
  OAuthClient,
  CreateClientInput,
  UpdateClientInput,
  ClientType,
  GrantType,
} from "@/features/auth-admin/api/oauth-clients/types";
import {
  Form,
  Input,
  Select,
  CheckboxGroup,
  TextArea,
  Col,
} from "@kosmeo-ui/react";

interface ClientFormProps {
  client?: OAuthClient;
  onSubmit: (data: CreateClientInput | UpdateClientInput) => void;
  formId?: string;
}

const CLIENT_TYPES: { value: ClientType; label: string }[] = [
  { value: "confidential", label: "Confidential (server-side apps)" },
  { value: "public", label: "Public (SPAs, mobile apps)" },
];

// Login clients only. A machine identity (client_credentials) is a service,
// added under /admin/services with its own client and service account.
const GRANT_TYPES: { value: GrantType; label: React.ReactNode }[] = [
  { value: "authorization_code", label: "Authorization Code" },
  { value: "refresh_token", label: "Refresh Token" },
];

const splitLines = (text: string) =>
  text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

const loginGrants = (grants: OAuthClient["grantTypes"]): GrantType[] =>
  grants.filter((g): g is GrantType => g !== "client_credentials");

export const ClientForm = ({ client, onSubmit, formId }: ClientFormProps) => {
  const [name, setName] = useState(client?.name || "");
  const [clientType, setClientType] = useState<ClientType>(
    client?.clientType || "confidential"
  );
  const [redirectUrisText, setRedirectUrisText] = useState(
    client?.redirectUris.join("\n") || ""
  );
  const [postLogoutUrisText, setPostLogoutUrisText] = useState(
    client?.postLogoutRedirectUris.join("\n") || ""
  );
  const [scopesText, setScopesText] = useState(client?.scopes.join(" ") || "");
  const [grantTypes, setGrantTypes] = useState<GrantType[]>(
    client
      ? loginGrants(client.grantTypes)
      : ["authorization_code", "refresh_token"]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const redirectUris = splitLines(redirectUrisText);
    const postLogoutRedirectUris = splitLines(postLogoutUrisText);
    const scopes = scopesText
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (client) {
      // Update mode
      const updates: UpdateClientInput = {};
      if (name !== client.name) updates.name = name;
      if (clientType !== client.clientType) updates.clientType = clientType;
      if (redirectUrisText !== client.redirectUris.join("\n"))
        updates.redirectUris = redirectUris;
      if (postLogoutUrisText !== client.postLogoutRedirectUris.join("\n"))
        updates.postLogoutRedirectUris = postLogoutRedirectUris;
      if (scopesText !== client.scopes.join(" ")) updates.scopes = scopes;
      if (
        JSON.stringify([...grantTypes].sort()) !==
        JSON.stringify(loginGrants(client.grantTypes).sort())
      )
        updates.grantTypes = grantTypes;
      onSubmit(updates);
    } else {
      // Create mode
      onSubmit({
        name,
        clientType,
        redirectUris,
        postLogoutRedirectUris,
        scopes,
        grantTypes,
      });
    }
  };

  return (
    <Form onSubmit={handleSubmit} id={formId}>
      <Col>
        <Input
          label="Name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="e.g., My Web App"
        />
        <Select
          label="Client Type"
          required
          value={clientType}
          onChange={(value) => {
            if (value) setClientType(value as ClientType);
          }}
          options={CLIENT_TYPES}
        />

        <CheckboxGroup
          name="grantTypes"
          label="Grant Types"
          options={GRANT_TYPES}
          values={grantTypes}
          onChange={(values) => setGrantTypes(values as GrantType[])}
        />

        <TextArea
          label="Redirect URIs"
          value={redirectUrisText}
          onChange={(e) => setRedirectUrisText(e.target.value)}
          placeholder="One URI per line (required for public clients)"
          rows={3}
        />

        <TextArea
          label="Post-Logout Redirect URIs"
          value={postLogoutUrisText}
          onChange={(e) => setPostLogoutUrisText(e.target.value)}
          placeholder="Optional - one URI per line"
          rows={2}
        />

        <Input
          label="Scopes"
          type="text"
          value={scopesText}
          onChange={(e) => setScopesText(e.target.value)}
          placeholder="openid profile email offline_access"
        />
      </Col>
    </Form>
  );
};
