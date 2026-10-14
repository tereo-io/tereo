import RevokeAllSessionsButton from "./buttons/RevokeAllSessionsButton";
import useUserPermissions from "../../api/users/useUserPermissions";
import useUserTotpStatus from "../../api/users/useUserTotpStatus";
import RevokeSessionButton from "./buttons/RevokeSessionButton";
import { UserConnectedAccounts } from "./UserConnectedAccounts";
import useUserSessions from "../../api/users/useUserSessions";
import ManageRolesButton from "./buttons/ManageRolesButton";
import ResetTotpButton from "./buttons/ResetTotpButton";
import useUserRoles from "../../api/users/useUserRoles";
import useDocumentTitle from "@/hooks/useDocumentTitle";
import EditUserButton from "./buttons/EditUserButton";
import { PageHeader } from "@/components/PageHeader";
import useUser from "../../api/users/useUser";
import { useParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import "./sessions.css";
import {
  Alert,
  Badge,
  BorderedSection,
  Card,
  Centered,
  Col,
  EmptyState,
  ListCard,
  Page,
  Row,
  SectionHeader,
  Spinner,
  TagCard,
} from "@kosmeo-ui/react";

export const UserDetail = () => {
  const { userId } = useParams<{ userId: string }>();

  const id = userId ?? "";
  const { hasPermission } = useAuth();
  // Core's /admin/users/:id routes: PATCH, PUT roles and TOTP reset need
  // users.write; revoking sessions and disabling TOTP need users.delete.
  const canWrite = hasPermission("users.write");
  const canDelete = hasPermission("users.delete");

  const { data: user, isLoading: userLoading } = useUser(id);
  const { data: rolesData } = useUserRoles(id);
  const { data: permissionsData } = useUserPermissions(id);
  const { data: sessionsData } = useUserSessions(id);
  const { data: totpStatus } = useUserTotpStatus(id);

  useDocumentTitle(user?.name || user?.email);

  if (userLoading) {
    return (
      <Page padded fillHeight>
        <Centered>
          <Spinner size="lg" />
        </Centered>
      </Page>
    );
  }

  if (!user) {
    return (
      <Page padded fillHeight>
        <EmptyState layout="block">User not found</EmptyState>
      </Page>
    );
  }

  return (
    <Page padded fillHeight>
      <PageHeader
        title={user.email}
        subtitle={`User ID: ${user.id}`}
        actions={
          canWrite
            ? [
                // Users are deactivated (Edit → Status), never deleted.
                <EditUserButton key="edit" user={user} />,
                <ManageRolesButton key="roles" userId={id} />,
              ]
            : []
        }
      />
      <Row>
        <Col>
          <ListCard
            listTitle="User Details"
            items={[
              { label: "Email", value: user.email },
              { label: "Name", value: user.name || "-" },
              {
                label: "Type",
                value: user.userType === "human" ? "Human" : "Service Account",
              },
              {
                label: "Status",
                value: (
                  <Badge
                    size="sm"
                    subtle={true}
                    variant={user.isActive ? "success" : "danger"}
                  >
                    {user.isActive ? "Active" : "Inactive"}
                  </Badge>
                ),
              },
              ...(user.userType === "human" && !user.hasPassword
                ? [
                    {
                      label: "Password",
                      value: (
                        <Badge size="sm" subtle={true} variant="warning">
                          No password
                        </Badge>
                      ),
                    },
                  ]
                : []),
              {
                label: "Created",
                value: new Date(user.createdAt).toLocaleString(),
              },
              {
                label: "Updated",
                value: new Date(user.updatedAt).toLocaleString(),
              },
            ]}
          />
          <Card>
            <SectionHeader
              title="Active Sessions"
              actions={
                canDelete ? <RevokeAllSessionsButton userId={id} /> : undefined
              }
            />
            {sessionsData?.sessions.length ? (
              <ul className="t-sessions-list">
                {sessionsData.sessions.map((session) => (
                  <li
                    key={session.id}
                    className={
                      session.isCurrent ? "t-session-current" : undefined
                    }
                  >
                    <BorderedSection>
                      <div className="t-session-header">
                        <div>
                          <div className="t-session-client">
                            {session.clientName}
                            {session.isCurrent && (
                              <Badge size="sm">Current</Badge>
                            )}
                          </div>
                          <Col size="sm">
                            <span>
                              Created:
                              {new Date(session.createdAt).toLocaleString()}
                            </span>
                            <span>
                              Expires:
                              {new Date(session.expiresAt).toLocaleString()}
                            </span>
                          </Col>
                        </div>
                        {!session.isCurrent && canDelete && (
                          <RevokeSessionButton userId={id} session={session} />
                        )}
                      </div>
                      {session.scopes.length > 0 && (
                        <div className="t-session-scopes">
                          {session.scopes.map((scope) => (
                            <Badge key={scope} size="sm" variant="secondary">
                              {scope}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </BorderedSection>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>No active sessions</EmptyState>
            )}
          </Card>
        </Col>
        <Col>
          <ListCard
            listTitle="Two-Factor Authentication"
            items={[
              {
                label: "Status",
                value: totpStatus ? (
                  <Badge
                    size="sm"
                    subtle={true}
                    variant={totpStatus.totpEnabled ? "success" : "danger"}
                  >
                    {totpStatus.totpEnabled ? "Enabled" : "Not Enabled"}
                  </Badge>
                ) : (
                  <Spinner size="sm" />
                ),
              },
              ...(totpStatus &&
              totpStatus.totpEnabled &&
              totpStatus.totpEnabledAt
                ? [
                    {
                      label: "Enabled On",
                      value: new Date(
                        totpStatus.totpEnabledAt
                      ).toLocaleString(),
                    },
                  ]
                : []),
              ...(totpStatus && totpStatus.totpEnabled
                ? [
                    {
                      label: "Recovery Codes",
                      value: (
                        <>
                          {totpStatus.recoveryCodesRemaining} remaining
                          {totpStatus.recoveryCodesRemaining <= 2 && (
                            <Alert variant="warning" size="sm">
                              Low - the user can regenerate them
                            </Alert>
                          )}
                        </>
                      ),
                    },
                  ]
                : []),
              {
                label: "Required",
                value: totpStatus ? (
                  totpStatus.totpRequired ? (
                    "Yes"
                  ) : (
                    "No"
                  )
                ) : (
                  <Spinner size="sm" />
                ),
              },
            ]}
            footerButtons={
              totpStatus?.totpEnabled && canWrite ? (
                <Row>{canWrite && <ResetTotpButton user={user} />}</Row>
              ) : null
            }
          />
          {user.userType === "human" && (
            <UserConnectedAccounts userId={id} email={user.email} />
          )}
          <TagCard
            title="Roles"
            emptyText="No roles assigned"
            tags={rolesData?.roles.map((r) => r.displayName) || []}
          />
          <TagCard
            title="Permissions"
            emptyText="No permissions"
            tags={permissionsData?.permissions.map((p) => p) || []}
            color="secondary"
          />
        </Col>
      </Row>
    </Page>
  );
};
