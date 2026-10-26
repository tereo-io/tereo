import RegenerateServiceSecretButton from "./buttons/RegenerateServiceSecretButton";
import RevokePreviousSecretButton from "./buttons/RevokePreviousSecretButton";
import ToggleServiceActiveButton from "./buttons/ToggleServiceActiveButton";
import { ProvisionedBadge } from "@/components/ProvisionedBadge";
import RenameServiceButton from "./buttons/RenameServiceButton";
import { ServiceAccessSection } from "./ServiceAccessSection";
import { DeclaredItemsSection } from "./DeclaredItemsSection";
import useDocumentTitle from "@/hooks/useDocumentTitle";
import { PageHeader } from "@/components/PageHeader";
import { userLabel, type UserRef } from "@/lib/refs";
import { formatDateTime } from "@/utils/formatDate";
import { ServiceStatusBadge } from "./StatusBadges";
import { Link, useParams } from "react-router-dom";
import { CORE_SERVICE_ID } from "../constants";
import useService from "../api/useService";
import { useAuth } from "@/lib/auth";
import {
  Alert,
  Badge,
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

export const ServiceDetail = () => {
  const { serviceId } = useParams<{ serviceId: string }>();
  const { hasPermission } = useAuth();
  const { data: service, isLoading } = useService(serviceId ?? "");

  useDocumentTitle(service?.name);

  if (isLoading) {
    return (
      <Page padded fillHeight>
        <Centered>
          <Spinner size="lg" />
        </Centered>
      </Page>
    );
  }

  if (!service) {
    return (
      <Page padded fillHeight>
        <EmptyState layout="block">Service not found</EmptyState>
      </Page>
    );
  }

  const isCore = service.id === CORE_SERVICE_ID;
  const canEndOverlap = !isCore && hasPermission("services.write");
  const canWrite = canEndOverlap && !service.provisioned;
  const overlapUntil =
    service.previousSecretExpiresAt &&
    new Date(service.previousSecretExpiresAt) > new Date()
      ? new Date(service.previousSecretExpiresAt)
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
        title={service.name}
        subtitle={service.slug}
        badges={
          <>
            <ServiceStatusBadge isActive={service.isActive} />
            {isCore && (
              <Badge size="sm" subtle variant="secondary">
                core
              </Badge>
            )}
            {service.provisioned && <ProvisionedBadge />}
          </>
        }
        actions={
          canWrite
            ? [
                <RenameServiceButton key="rename" service={service} />,
                <RegenerateServiceSecretButton
                  key="regenerate"
                  service={service}
                />,
                <ToggleServiceActiveButton key="active" service={service} />,
              ]
            : undefined
        }
      />
      <Col size="lg">
        {isCore && (
          <Alert variant="primary">
            Core&apos;s own declaration is applied from its code on every start.
            It is shown here for reference and cannot be changed.
          </Alert>
        )}
        {service.provisioned && (
          <Alert variant="primary">
            This service comes from a provisioning document. Change its name or
            secret there; it applies on the next deploy or{" "}
            <code>provision</code> run. Its access is still approved and revoked
            here, and a rotated secret&apos;s overlap can still be ended early.
          </Alert>
        )}
        {!service.isActive && (
          <Alert variant="warning">
            This service is deactivated: its tokens are revoked and it cannot
            get new ones.
          </Alert>
        )}
        {overlapUntil && (
          <Alert variant="warning" heading="Two secrets work right now">
            <Col>
              <span>
                The secret replaced by the last regeneration keeps working until{" "}
                {formatDateTime(overlapUntil)}, so running copies keep calling
                core while the new one rolls out. End the overlap once every
                copy uses the new secret.
              </span>
              {canEndOverlap && (
                <div>
                  <RevokePreviousSecretButton service={service} />
                </div>
              )}
            </Col>
          </Alert>
        )}
        <Row>
          <Col>
            <ListCard
              listTitle="Service Details"
              items={[
                {
                  label: "Slug",
                  value: <span className="v-mono">{service.slug}</span>,
                },
                {
                  label: "Namespace",
                  value: <span className="v-mono">{service.namespace}</span>,
                },
                {
                  label: "Client ID",
                  value: service.clientId ? (
                    <span className="v-mono">{service.clientId}</span>
                  ) : (
                    muted("None — core uses no OAuth client")
                  ),
                },
                {
                  label: "Service Account",
                  value: service.serviceAccountUser
                    ? userLink(service.serviceAccountUser)
                    : muted("—"),
                },
                {
                  label: "Created By",
                  value: service.creator
                    ? userLink(service.creator)
                    : muted("—"),
                },
                {
                  label: "Declaration Version",
                  value: service.declarationVersion ?? muted("—"),
                },
                {
                  label: "Last Applied",
                  value: service.declaredAt
                    ? formatDateTime(service.declaredAt)
                    : muted("Never"),
                },
                {
                  label: "Created",
                  value: formatDateTime(service.createdAt),
                },
              ]}
            />
          </Col>
          <Col>
            <TagCard
              title="Audience"
              tags={service.audience}
              emptyText="No audiences approved"
              color="secondary"
            />
          </Col>
        </Row>
        <ServiceAccessSection service={service} readOnly={isCore} />
        <DeclaredItemsSection service={service} />
      </Col>
    </Page>
  );
};
