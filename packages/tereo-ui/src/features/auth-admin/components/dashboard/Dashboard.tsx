import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import usePermissions from "../../api/dashboard/usePermissions";
import useClients from "../../api/dashboard/useClients";
import { PageHeader } from "@/components/PageHeader";
import useUsers from "../../api/dashboard/useUsers";
import useRoles from "../../api/dashboard/useRoles";
import { formatDate } from "@/utils/formatDate";
import { Link } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import env from "@/lib/env";
import "./styles.css";
import {
  faUsers,
  faUserShield,
  faKey,
  faServer,
  faChevronRight,
} from "@fortawesome/free-solid-svg-icons";
import {
  Card,
  Centered,
  Col,
  EmptyState,
  Page,
  Row,
  Spinner,
  StatCard,
  type StatCardIconVariant,
} from "@kosmeo-ui/react";

// Core's lists are cursor-paginated without totals; one page of up to 200
// rows gives an exact count below that and "200+" above it.
const countLabel = (page?: { data: unknown[]; hasMore: boolean }) =>
  page ? `${page.data.length}${page.hasMore ? "+" : ""}` : "0";

export const Dashboard = () => {
  const { user, hasPermission } = useAuth();
  const canReadUsers = hasPermission("users.read");
  const canReadClients = hasPermission("clients.read");
  // Without clients.admin, core lists only the clients the caller owns.
  const clientsLabel = hasPermission("clients.admin")
    ? "OAuth Clients"
    : "Your OAuth Clients";

  const { data: usersData, isLoading: usersLoading } = useUsers();
  const { data: rolesData, isLoading: rolesLoading } = useRoles();
  const { data: permissionsData, isLoading: permissionsLoading } =
    usePermissions();
  const { data: clientsData, isLoading: clientsLoading } = useClients();

  const isLoading =
    usersLoading || rolesLoading || permissionsLoading || clientsLoading;

  const stats: {
    label: string;
    count: string;
    icon: typeof faUsers;
    link: string;
    iconVariant: StatCardIconVariant;
    permission: string;
  }[] = [
    {
      label: "Users",
      count: countLabel(usersData),
      icon: faUsers,
      link: "/auth-admin/users",
      permission: "users.read",
      iconVariant: "primary",
    },
    {
      label: "Roles",
      count: countLabel(rolesData),
      icon: faUserShield,
      link: "/auth-admin/roles",
      permission: "roles.read",
      iconVariant: "success",
    },
    {
      label: "Permissions",
      count: countLabel(permissionsData),
      icon: faKey,
      link: "/auth-admin/permissions",
      permission: "permissions.read",
      iconVariant: "warning",
    },
    {
      label: clientsLabel,

      count: countLabel(clientsData),
      icon: faServer,
      link: "/auth-admin/oauth-clients",
      permission: "clients.read",
      iconVariant: "danger",
    },
  ];

  return (
    <Page padded fillHeight>
      <PageHeader
        title="Dashboard"
        subtitle={`Welcome back, ${user?.name || user?.email || "Admin"}`}
      />

      {isLoading ? (
        <Centered>
          <Spinner size="lg" />
        </Centered>
      ) : (
        <Col>
          <Row>
            {stats
              .filter((stat) => hasPermission(stat.permission))
              .map((stat) => (
                <Col key={stat.label}>
                  <StatCard
                    href={`${env.BASE_PATH}${stat.link}`}
                    icon={<FontAwesomeIcon icon={stat.icon} />}
                    iconVariant={stat.iconVariant}
                    trailing={<FontAwesomeIcon icon={faChevronRight} />}
                    label={stat.label}
                    value={stat.count}
                  />
                </Col>
              ))}
          </Row>

          <Row>
            {canReadUsers && (
              <Col>
                <Card>
                  <h3>Recent Users</h3>
                  {usersData?.data && usersData.data.length > 0 ? (
                    <ul className="t-recent-list">
                      {usersData.data.slice(0, 5).map((u) => (
                        <li key={u.id}>
                          <Link to={`/auth-admin/users/${u.id}`}>
                            <span className="t-recent-name">{u.email}</span>
                            <span className="v-help-text">
                              {formatDate(u.createdAt)}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState>No users yet</EmptyState>
                  )}
                  <Link to="/auth-admin/users" className="t-view-all">
                    View all users
                  </Link>
                </Card>
              </Col>
            )}
            {canReadClients && (
              <Col>
                <Card>
                  <h3>Recent Clients</h3>
                  {clientsData?.data && clientsData.data.length > 0 ? (
                    <ul className="t-recent-list">
                      {clientsData.data.slice(0, 5).map((client) => (
                        <li key={client.id}>
                          <Link to={`/auth-admin/oauth-clients/${client.id}`}>
                            <span className="t-recent-name">{client.name}</span>
                            <span className="v-help-text">
                              {client.clientType}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState>No clients yet</EmptyState>
                  )}
                  <Link to="/auth-admin/oauth-clients" className="t-view-all">
                    View all clients
                  </Link>
                </Card>
              </Col>
            )}
          </Row>
        </Col>
      )}
    </Page>
  );
};
