import ArchiveRestoreWebhookEndpointButton from "./buttons/ArchiveRestoreWebhookEndpointButton";
import useUpdateWebhookEndpoint from "../../api/endpoints/useUpdateWebhookEndpoint";
import useWebhookEndpointStats from "../../api/endpoints/useWebhookEndpointStats";
import DeleteWebhookEndpointButton from "./buttons/DeleteWebhookEndpointButton";
import RevokePreviousSecretButton from "./buttons/RevokePreviousSecretButton";
import TestWebhookEndpointButton from "./buttons/TestWebhookEndpointButton";
import EditWebhookEndpointButton from "./buttons/EditWebhookEndpointButton";
import useWebhookEndpoint from "../../api/endpoints/useWebhookEndpoint";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ProvisionedBadge } from "@/components/ProvisionedBadge";
import RotateSecretButton from "./buttons/RotateSecretButton";
import { DeliveryList } from "../deliveries/DeliveryList";
import useDocumentTitle from "@/hooks/useDocumentTitle";
import type { WebhookEndpoint } from "../../api/types";
import { PageHeader } from "@/components/PageHeader";
import { EndpointStatusBadges } from "../badges";
import formatDate from "@/utils/formatDate";
import { userLabel } from "@/lib/refs";
import { useAuth } from "@/lib/auth";
import "../styles.css";
import {
  Alert,
  Badge,
  Button,
  Card,
  Centered,
  Col,
  EmptyState,
  ListCard,
  Page,
  Row,
  Spinner,
  StatCard,
  TabButton,
} from "@kosmeo-ui/react";

type Tab = "details" | "deliveries";

const isValidTab = (tab: string | null): tab is Tab =>
  tab === "details" || tab === "deliveries";

export const WebhookEndpointDetail = () => {
  const { hasPermission } = useAuth();
  const { endpointId } = useParams<{ endpointId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: endpoint, isLoading } = useWebhookEndpoint(endpointId ?? "");
  const updateMutation = useUpdateWebhookEndpoint();

  const tabFromUrl = searchParams.get("tab");
  const activeTab: Tab = isValidTab(tabFromUrl) ? tabFromUrl : "details";
  const setActiveTab = (tab: Tab) =>
    setSearchParams(
      (params) => {
        params.set("tab", tab);
        return params;
      },
      { replace: true }
    );

  useDocumentTitle(endpoint?.url);

  if (!hasPermission("webhooks.read")) return null;

  if (isLoading) {
    return (
      <Page padded fillHeight>
        <Centered>
          <Spinner size="lg" />
        </Centered>
      </Page>
    );
  }

  if (!endpoint) {
    return (
      <Page padded fillHeight>
        <EmptyState layout="block">Webhook endpoint not found</EmptyState>
      </Page>
    );
  }

  return (
    <Page padded fillHeight>
      <PageHeader
        title={endpoint.description || "Webhook Endpoint"}
        subtitle={endpoint.url}
        badges={
          <>
            <EndpointStatusBadges endpoint={endpoint} />
            {endpoint.provisioned && <ProvisionedBadge />}
          </>
        }
        actions={[
          <TestWebhookEndpointButton
            key="test"
            endpoint={endpoint}
            onSent={() => setActiveTab("deliveries")}
          />,
          ...(endpoint.provisioned
            ? endpoint.status === "DISABLED" &&
              !endpoint.archivedAt &&
              hasPermission("webhooks.write")
              ? [
                  <Button
                    key="re-enable"
                    variant="secondary"
                    size="sm"
                    isLoading={updateMutation.isPending}
                    onClick={() =>
                      updateMutation.mutate({
                        id: endpoint.id,
                        updateData: { status: "ACTIVE" },
                      })
                    }
                  >
                    Re-enable
                  </Button>,
                ]
              : []
            : [
                <RotateSecretButton key="rotate" endpoint={endpoint} />,
                <RevokePreviousSecretButton
                  key="revoke-previous"
                  endpoint={endpoint}
                />,
                <EditWebhookEndpointButton key="edit" endpoint={endpoint} />,
                <ArchiveRestoreWebhookEndpointButton
                  key="archive"
                  endpoint={endpoint}
                  navigateOnArchive
                />,
                <DeleteWebhookEndpointButton
                  key="delete"
                  endpoint={endpoint}
                />,
              ]),
        ]}
      />

      {endpoint.provisioned && (
        <Alert variant="primary">
          This endpoint comes from the provisioning file. Change or remove it
          there and restart core. Deliveries, retries and test sends still work
          here.
        </Alert>
      )}

      {endpoint.archivedAt && (
        <Alert variant="warning">
          Archived {formatDate(endpoint.archivedAt)}. It receives no deliveries
          and is read-only until restored.
        </Alert>
      )}
      {!endpoint.archivedAt && endpoint.previousSecretExpiresAt && (
        <Alert variant="primary">
          Secret rotation in progress: deliveries are signed with both the new
          and the previous secret until{" "}
          {formatDate(endpoint.previousSecretExpiresAt)}.
        </Alert>
      )}
      {!endpoint.archivedAt && endpoint.status === "DISABLED" && (
        <Alert variant="danger">
          Core disabled this endpoint after repeated delivery failures. Fix the
          receiver, then set its status back to Active.
        </Alert>
      )}

      <div className="t-webhook-tabs-header">
        <TabButton
          active={activeTab === "details"}
          onClick={() => setActiveTab("details")}
        >
          Details
        </TabButton>
        <TabButton
          active={activeTab === "deliveries"}
          onClick={() => setActiveTab("deliveries")}
        >
          Deliveries
        </TabButton>
      </div>

      {activeTab === "details" && <EndpointDetails endpoint={endpoint} />}
      {activeTab === "deliveries" && <DeliveryList endpoint={endpoint} />}
    </Page>
  );
};

const EndpointDetails = ({ endpoint }: { endpoint: WebhookEndpoint }) => {
  const { data: stats } = useWebhookEndpointStats(endpoint.id);
  const headers = Object.entries(endpoint.customHeaders ?? {});

  return (
    <>
      {stats && (
        <div className="t-webhook-stats">
          <StatCard
            compact
            label={`Deliveries (${stats.windowDays}d)`}
            value={stats.total}
          />
          <StatCard
            compact
            label="Success rate"
            value={`${Math.round(stats.successRate * 1000) / 10}%`}
          />
          <StatCard compact label="Failed" value={stats.failed} />
          <StatCard compact label="Pending" value={stats.pending} />
          <StatCard
            compact
            label="Last 24h"
            value={`${stats.last24Hours.success} ok / ${stats.last24Hours.failed} failed`}
          />
          <StatCard
            compact
            label="Avg. attempts"
            value={stats.averageAttempts}
          />
        </div>
      )}
      <Row>
        <Col>
          <ListCard
            listTitle="Endpoint Details"
            items={[
              {
                label: "ID",
                value: <span className="v-mono">{endpoint.id}</span>,
              },
              {
                label: "URL",
                value: <span className="t-webhook-url">{endpoint.url}</span>,
              },
              ...(endpoint.ownerService
                ? [
                    {
                      label: "Owning Service",
                      value: (
                        <Link
                          className="v-link"
                          to={`/services/${endpoint.ownerService.id}`}
                        >
                          {endpoint.ownerService.name}
                        </Link>
                      ),
                    },
                  ]
                : []),
              ...(endpoint.organizationId === null
                ? [{ label: "Organization", value: "All organizations" }]
                : []),
              {
                label: "Description",
                value: endpoint.description || (
                  <span className="v-muted-text">No description</span>
                ),
              },
              {
                label: "Status",
                value: <EndpointStatusBadges endpoint={endpoint} />,
              },
              {
                label: "Signing Secret",
                value: <span className="v-mono">{endpoint.signingSecret}</span>,
              },
              ...(endpoint.previousSecretExpiresAt
                ? [
                    {
                      label: "Previous Secret Signs Until",
                      value: formatDate(endpoint.previousSecretExpiresAt),
                    },
                  ]
                : []),
              {
                label: "Consecutive Failures",
                value: endpoint.consecutiveFailures,
              },
              {
                label: "Created By",
                value: (
                  <span title={endpoint.creator.email}>
                    {userLabel(endpoint.creator)}
                  </span>
                ),
              },
              { label: "Created", value: formatDate(endpoint.createdAt) },
              { label: "Updated", value: formatDate(endpoint.updatedAt) },
            ]}
          />
        </Col>
        <Col>
          <Card>
            <h3>Event Types</h3>
            {endpoint.eventTypes.length ? (
              <ul className="t-webhook-event-list">
                {endpoint.eventTypes.map((et) => (
                  <li key={et}>
                    {et}
                    {endpoint.retiredEventTypes.includes(et) && (
                      <Badge size="sm" variant="warning">
                        Retired
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>No event types</EmptyState>
            )}
          </Card>
          <ListCard
            listTitle="Custom Headers"
            items={
              headers.length
                ? headers.map(([name, value]) => ({
                    label: name,
                    value: <span className="v-mono">{value}</span>,
                  }))
                : [
                    {
                      label: "None",
                      value: (
                        <span className="v-muted-text">No custom headers</span>
                      ),
                    },
                  ]
            }
          />
        </Col>
      </Row>
    </>
  );
};
