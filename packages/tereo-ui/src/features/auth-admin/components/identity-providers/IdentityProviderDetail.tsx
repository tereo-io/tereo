import useIdentityProvider from "../../api/identity-providers/useIdentityProvider";
import ToggleProviderActiveButton from "./buttons/ToggleProviderActiveButton";
import EditIdentityProviderButton from "./buttons/EditIdentityProviderButton";
import useDocumentTitle from "@/hooks/useDocumentTitle";
import { PageHeader } from "@/components/PageHeader";
import { ProviderDomains } from "./ProviderDomains";
import { useParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import "./styles.css";
import {
  Badge,
  Card,
  Centered,
  Col,
  EmptyState,
  ListCard,
  Page,
  Row,
  SecretDisplay,
  Spinner,
} from "@kosmeo-ui/react";

export const IdentityProviderDetail = () => {
  const { providerId } = useParams<{ providerId: string }>();
  const { data: provider, isLoading } = useIdentityProvider(providerId ?? "");
  const { hasPermission } = useAuth();

  useDocumentTitle(provider?.displayName);

  if (isLoading) {
    return (
      <Page padded fillHeight>
        <Centered>
          <Spinner size="lg" />
        </Centered>
      </Page>
    );
  }

  if (!provider) {
    return (
      <Page padded fillHeight>
        <EmptyState layout="block">Identity provider not found</EmptyState>
      </Page>
    );
  }

  return (
    <Page padded fillHeight>
      <PageHeader
        title={provider.displayName}
        subtitle={`${provider.kind.toUpperCase()} provider`}
        actions={
          hasPermission("identity-providers.write")
            ? [
                <EditIdentityProviderButton key="edit" provider={provider} />,
                <ToggleProviderActiveButton key="toggle" provider={provider} />,
              ]
            : []
        }
      />
      <Row>
        <Col>
          <ListCard
            listTitle="Provider Details"
            items={[
              { label: "Name", value: provider.displayName },
              {
                label: "Slug",
                value: <span className="v-mono">{provider.slug}</span>,
              },
              { label: "Issuer", value: provider.issuer },
              {
                label: "Client ID",
                value: <span className="v-mono">{provider.clientId}</span>,
              },
              { label: "Client Secret", value: "Stored, never shown" },
              { label: "Scopes", value: provider.scopes.join(" ") || "-" },
              {
                label: "Counts as MFA",
                value: provider.countsAsMfa ? (
                  <Badge size="sm" subtle variant="warning">
                    Yes: skips core's TOTP
                  </Badge>
                ) : (
                  "No"
                ),
              },
              {
                label: "Status",
                value: (
                  <Badge
                    size="sm"
                    subtle
                    variant={provider.isActive ? "success" : "danger"}
                  >
                    {provider.isActive ? "Active" : "Inactive"}
                  </Badge>
                ),
              },
              {
                label: "Created",
                value: new Date(provider.createdAt).toLocaleString(),
              },
            ]}
          />
          <Card>
            <h3>Callback URL</h3>
            <p>Register this as the redirect URI at the provider.</p>
            <SecretDisplay value={provider.callbackUrl} />
          </Card>
        </Col>
        <Col>
          <ProviderDomains providerId={provider.id} />
        </Col>
      </Row>
    </Page>
  );
};
