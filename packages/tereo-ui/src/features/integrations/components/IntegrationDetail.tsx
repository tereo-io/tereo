import RevokePreviousIntegrationSecretButton from "./buttons/RevokePreviousIntegrationSecretButton";
import RegenerateIntegrationSecretButton from "./buttons/RegenerateIntegrationSecretButton";
import EditIntegrationAudiencesButton from "./buttons/EditIntegrationAudiencesButton";
import ToggleIntegrationActiveButton from "./buttons/ToggleIntegrationActiveButton";
import RenameIntegrationButton from "./buttons/RenameIntegrationButton";
import { IntegrationStatusBadge, ScopeBadge } from "./StatusBadges";
import { ProvisionedBadge } from "@/components/ProvisionedBadge";
import useDocumentTitle from "@/hooks/useDocumentTitle";
import { PageHeader } from "@/components/PageHeader";
import { userLabel, type UserRef } from "@/lib/refs";
import { Link, useParams } from "react-router-dom";
import useIntegration from "../api/useIntegration";
import { useAuth } from "@/lib/auth";
import EditIntegrationRolesButton, {
  GLOBAL_ROLES_WARNING,
} from "./buttons/EditIntegrationRolesButton";
import {
  Alert,
  Centered,
  Col,
  EmptyState,
  ListCard,
  Page,
  Row,
  Spinner,
  TagCard,
} from "@kosmeo-ui/react";

const muted = (text: string) => <span className="v-muted-text">{text}</span>;

export const IntegrationDetail = () => {
  const { integrationId } = useParams<{ integrationId: string }>();
  const { hasPermission } = useAuth();
  const { data: integration, isLoading } = useIntegration(integrationId ?? "");

  useDocumentTitle(integration?.name);

  if (isLoading) {
    return (
      <Page padded fillHeight>
        <Centered>
          <Spinner size="lg" />
        </Centered>
      </Page>
    );
  }

  if (!integration) {
    return (
      <Page padded fillHeight>
        <EmptyState layout="block">Integration not found</EmptyState>
      </Page>
    );
  }

  const orgBound = integration.organizationId !== null;
  const canEndOverlap = hasPermission("integrations.write");
  // Provisioned integrations change in their document; only ending a secret
  // overlap early stays available here.
  const canWrite = canEndOverlap && !integration.provisioned;
  const overlapUntil =
    integration.previousSecretExpiresAt &&
    new Date(integration.previousSecretExpiresAt) > new Date()
      ? new Date(integration.previousSecretExpiresAt)
      : null;
  const userLink = (user: UserRef) =>
    hasPermission("admin") ? (
      <Link
        className="v-link"
        to={`/auth-admin/users/${user.id}`}
        title={user.email}
      >
        {userLabel(user)}
      </Link>
    ) : (
      <span title={user.email}>{userLabel(user)}</span>
    );

  return (
    <Page padded fillHeight>
      <PageHeader
        title={integration.name}
        subtitle={integration.slug}
        badges={
          <>
            <IntegrationStatusBadge isActive={integration.isActive} />
            <ScopeBadge bound={orgBound} />
            {integration.provisioned && <ProvisionedBadge />}
          </>
        }
        actions={
          canWrite
            ? [
                <RenameIntegrationButton
                  key="rename"
                  integration={integration}
                />,
                <RegenerateIntegrationSecretButton
                  key="regenerate"
                  integration={integration}
                />,
                <ToggleIntegrationActiveButton
                  key="active"
                  integration={integration}
                />,
              ]
            : undefined
        }
      />
      <Col size="lg">
        {integration.provisioned && (
          <Alert variant="primary">
            This integration comes from a provisioning document. Change its
            name, secret, roles and audiences there; it applies on the next
            deploy or <code>provision</code> run. A rotated secret&apos;s
            overlap can still be ended early here.
          </Alert>
        )}
        {!integration.isActive && (
          <Alert variant="warning">
            This integration is deactivated: its tokens are revoked and it
            cannot get new ones.
          </Alert>
        )}
        {overlapUntil && (
          <Alert variant="warning" heading="Two secrets work right now">
            <Col>
              <span>
                The secret replaced by the last regeneration keeps working until{" "}
                {overlapUntil.toLocaleString()}. End the overlap once the
                external party uses the new secret.
              </span>
              {canEndOverlap && (
                <div>
                  <RevokePreviousIntegrationSecretButton
                    integration={integration}
                  />
                </div>
              )}
            </Col>
          </Alert>
        )}
        <Row>
          <Col>
            <ListCard
              listTitle="Integration Details"
              items={[
                {
                  label: "Slug",
                  value: <span className="v-mono">{integration.slug}</span>,
                },
                {
                  label: "Organization",
                  value: integration.organization ? (
                    hasPermission("admin") ? (
                      <Link
                        className="v-link"
                        to={`/auth-admin/organizations/${integration.organization.id}`}
                      >
                        {integration.organization.name}
                      </Link>
                    ) : (
                      integration.organization.name
                    )
                  ) : (
                    muted("Platform (no organization)")
                  ),
                },
                {
                  label: "Client ID",
                  value: integration.clientId ? (
                    <span className="v-mono">{integration.clientId}</span>
                  ) : (
                    muted("—")
                  ),
                },
                {
                  label: "Service Account",
                  value: integration.serviceAccountUser
                    ? userLink(integration.serviceAccountUser)
                    : muted("—"),
                },
                {
                  label: "Created By",
                  value: integration.creator
                    ? userLink(integration.creator)
                    : muted("—"),
                },
                {
                  label: "Created",
                  value: new Date(integration.createdAt).toLocaleString(),
                },
              ]}
            />
          </Col>
          <Col>
            <TagCard
              title="Audience"
              tags={integration.audience}
              emptyText="No audiences"
              color="secondary"
            />
            {canWrite && (
              <div>
                <EditIntegrationAudiencesButton integration={integration} />
              </div>
            )}
          </Col>
        </Row>
        {!orgBound && <Alert variant="warning">{GLOBAL_ROLES_WARNING}</Alert>}
        <TagCard
          title={orgBound ? "Organization Roles" : "Global Roles"}
          tags={integration.roles.map((r) => r.displayName)}
          emptyText="No roles"
          color="secondary"
        />
        {canWrite && (
          <div>
            <EditIntegrationRolesButton integration={integration} />
          </div>
        )}
      </Col>
    </Page>
  );
};
