import RegenerateSecretButton from "./buttons/RegenerateSecretButton";
import { faLock, faUnlock } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import DeleteClientButton from "./buttons/DeleteClientButton";
import EditClientButton from "./buttons/EditClientButton";
import useClient from "../../api/oauth-clients/useClient";
import useDocumentTitle from "@/hooks/useDocumentTitle";
import { PageHeader } from "@/components/PageHeader";
import { useParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import "./styles.css";
import {
  Card,
  Centered,
  Col,
  EmptyState,
  ListCard,
  Page,
  Row,
  Spinner,
  TagCard,
} from "@kosmeo-ui/react";

export const ClientDetail = () => {
  const { clientId } = useParams<{ clientId: string }>();
  const { data: client, isLoading } = useClient(clientId ?? "");
  const { hasPermission, user } = useAuth();

  useDocumentTitle(client?.name);

  if (isLoading) {
    return (
      <Page padded fillHeight>
        <Centered>
          <Spinner size="lg" />
        </Centered>
      </Page>
    );
  }

  if (!client) {
    return (
      <Page padded fillHeight>
        <EmptyState layout="block">Client not found</EmptyState>
      </Page>
    );
  }

  // Core lets a client's owner, or a clients.admin holder, change it.
  const canManage =
    client.ownerId === user?.sub || hasPermission("clients.admin");

  return (
    <Page padded fillHeight>
      <PageHeader
        title={client.name}
        subtitle={`${client.clientType} client`}
        actions={
          client.service || !canManage
            ? []
            : [
                ...(hasPermission("clients.write")
                  ? [
                      <EditClientButton key="edit" client={client} />,
                      <RegenerateSecretButton
                        key="regenerate"
                        client={client}
                      />,
                    ]
                  : []),
                ...(hasPermission("clients.delete")
                  ? [<DeleteClientButton key="delete" client={client} />]
                  : []),
              ]
        }
      />
      <Row>
        <Col>
          <ListCard
            listTitle="Client Details"
            items={[
              {
                label: "Client ID",
                value: <span className="v-mono">{client.clientId}</span>,
              },
              { label: "Name", value: client.name },
              ...(client.service
                ? [
                    {
                      label: "Service",
                      value: `${client.service.name} (managed under Services)`,
                    },
                  ]
                : []),
              {
                label: "Type",
                value: (
                  <span className="t-client-type-header">
                    <FontAwesomeIcon
                      icon={
                        client.clientType === "confidential" ? faLock : faUnlock
                      }
                    />
                    {client.clientType}
                  </span>
                ),
              },
              ...(client.owner
                ? [
                    {
                      label: "Owner",
                      value: (
                        <span>
                          {client.owner.name || client.owner.email}
                          {client.owner.name && (
                            <span className="v-mono v-muted-text t-owner-email">
                              ({client.owner.email})
                            </span>
                          )}
                        </span>
                      ),
                    },
                  ]
                : []),
              {
                label: "Created",
                value: new Date(client.createdAt).toLocaleString(),
              },
              {
                label: "Updated",
                value: new Date(client.updatedAt).toLocaleString(),
              },
            ]}
          />
          <TagCard
            title="Grant Types"
            emptyText="No Grant Types"
            tags={client.grantTypes.map((g) => g)}
            color="secondary"
          />
        </Col>
        <Col>
          {client.serviceAccountUser && (
            <ListCard
              listTitle="Service Account"
              items={[
                {
                  label: "Name",
                  value: client.serviceAccountUser.name || "N/A",
                },
                {
                  label: "Email",
                  value: (
                    <span className="v-mono">
                      {client.serviceAccountUser.email}
                    </span>
                  ),
                },
                {
                  label: "User ID",
                  value: client.serviceAccountUser.id,
                },
              ]}
            />
          )}
          <Card>
            <h3>Redirect URIs</h3>
            {client.redirectUris.length ? (
              <ul className="t-uri-list">
                {client.redirectUris.map((uri, i) => (
                  <li key={i} className="v-mono">
                    {uri}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>No redirect URIs configured</EmptyState>
            )}
          </Card>
          {client.postLogoutRedirectUris.length > 0 && (
            <Card>
              <h3>Post-Logout Redirect URIs</h3>
              <ul className="t-uri-list">
                {client.postLogoutRedirectUris.map((uri, i) => (
                  <li key={i} className="v-mono">
                    {uri}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <TagCard
            title="Scopes"
            tags={client.scopes.map((s) => s)}
            emptyText="No scopes configured"
            color="secondary"
          />
          {client.audience.length > 0 && (
            <Card>
              <h3>Audience</h3>
              <ul className="t-uri-list">
                {client.audience.map((aud, i) => (
                  <li key={i} className="v-mono">
                    {aud}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </Col>
      </Row>
    </Page>
  );
};
