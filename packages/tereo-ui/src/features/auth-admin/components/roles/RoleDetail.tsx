import RemoveUserFromRoleButton from "./buttons/RemoveUserFromRoleButton";
import ArchiveRestoreRoleButton from "./buttons/ArchiveRestoreRoleButton";
import ManagePermissionsButton from "./buttons/ManagePermissionsButton";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import DuplicateRoleButton from "./buttons/DuplicateRoleButton";
import { faLock } from "@fortawesome/free-solid-svg-icons";
import DeleteRoleButton from "./buttons/DeleteRoleButton";
import useRoleUsers from "../../api/roles/useRoleUsers";
import useDocumentTitle from "@/hooks/useDocumentTitle";
import type { RoleUser } from "../../api/roles/types";
import EditRoleButton from "./buttons/EditRoleButton";
import { PageHeader } from "@/components/PageHeader";
import { useParams, Link } from "react-router-dom";
import useRole from "../../api/roles/useRole";
import { useAuth } from "@/lib/auth";
import { useMemo } from "react";
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
  Spinner,
  Table,
  TagCard,
  type TableColumn,
} from "@kosmeo-ui/react";

export const RoleDetail = () => {
  const { roleId } = useParams<{ roleId: string }>();

  const id = roleId ?? "";
  const { hasPermission } = useAuth();
  // PATCH and PUT permissions need roles.write; removing a user needs
  // roles.delete. Duplicate, archive and delete check their own.
  const canWrite = hasPermission("roles.write");
  const canRemoveUsers = hasPermission("roles.delete");

  const { data: role, isLoading } = useRole(id);
  const { data: usersData } = useRoleUsers(id);

  useDocumentTitle(role?.displayName || role?.name);

  const userColumns: TableColumn<RoleUser>[] = useMemo(
    () => [
      {
        title: "Email",
        dataKey: "email",
        cellElement: (user) => (
          <Link to={`/auth-admin/users/${user.id}`} className="v-link">
            {user.email}
          </Link>
        ),
      },
      {
        title: "Name",
        dataKey: "name",
        cellElement: (user) => user.name || "-",
      },
      {
        title: "Status",
        dataKey: "isActive",
        cellElement: (user) => (
          <Badge
            size="sm"
            subtle={true}
            variant={user.isActive ? "success" : "danger"}
          >
            {user.isActive ? "Active" : "Inactive"}
          </Badge>
        ),
      },
      {
        title: "Scope",
        dataKey: "organizationId",
        cellElement: (user) =>
          user.organizationId ? (
            <Link
              to={`/auth-admin/organizations/${user.organizationId}`}
              className="v-link"
            >
              {user.organization?.name ?? user.organizationId}
            </Link>
          ) : (
            "Global"
          ),
      },
      {
        title: "Expires",
        dataKey: "expiresAt",
        cellElement: (user) =>
          user.expiresAt ? new Date(user.expiresAt).toLocaleDateString() : "-",
      },
      ...(canRemoveUsers
        ? [
            {
              title: "Actions",
              cellElement: (user: RoleUser) => (
                <RemoveUserFromRoleButton
                  roleId={id}
                  roleDisplayName={role?.displayName || ""}
                  user={user}
                />
              ),
            },
          ]
        : []),
    ],
    [id, role?.displayName, canRemoveUsers]
  );

  if (isLoading) {
    return (
      <Page padded fillHeight>
        <Centered>
          <Spinner size="lg" />
        </Centered>
      </Page>
    );
  }

  if (!role) {
    return (
      <Page padded fillHeight>
        <EmptyState layout="block">Role not found</EmptyState>
      </Page>
    );
  }

  return (
    <Page padded fillHeight>
      <PageHeader
        title={role.displayName}
        subtitle={`Role: ${role.name}`}
        badges={
          <>
            {role.isSystem && (
              <Badge variant="secondary">
                <FontAwesomeIcon icon={faLock} /> System
              </Badge>
            )}
            {role.retiredAt && <Badge variant="danger">Retired</Badge>}
            {role.archivedAt && <Badge variant="warning">Archived</Badge>}
          </>
        }
        actions={[
          // A system role is code-owned: only its 2FA policy is editable
          // (EditRoleButton limits the form), its permissions are not, and it
          // can't be archived or deleted (those buttons hide themselves).
          ...(!canWrite || role.archivedAt || role.retiredAt
            ? []
            : [<EditRoleButton key="edit" role={role} />]),
          ...(!canWrite || role.archivedAt || role.isSystem
            ? []
            : [<ManagePermissionsButton key="permissions" role={role} />]),
          ...(role.archivedAt
            ? []
            : [<DuplicateRoleButton key="duplicate" role={role} />]),
          <ArchiveRestoreRoleButton key="archive" role={role} />,
          <DeleteRoleButton
            key="delete"
            role={role}
            userCount={usersData?.users.length ?? 0}
          />,
        ]}
      />
      <Row>
        <Col>
          <ListCard
            listTitle="Role Details"
            items={[
              { label: "Name", value: role.name },
              { label: "Display Name", value: role.displayName },
              { label: "Description", value: role.description || "-" },
              {
                label: "Type",
                value: role.isSystem ? (
                  <span>
                    <FontAwesomeIcon icon={faLock} /> System — declared by{" "}
                    {role.service ? (
                      <Link
                        to={`/services/${role.service.id}`}
                        className="v-link"
                      >
                        {role.service.name}
                      </Link>
                    ) : (
                      role.serviceId
                    )}
                  </span>
                ) : (
                  "Custom"
                ),
              },
              ...(role.retiredAt
                ? [
                    {
                      label: "Retired",
                      value: new Date(role.retiredAt).toLocaleString(),
                    },
                  ]
                : []),
              {
                label: "Status",
                value: (
                  <Badge
                    size="sm"
                    subtle={true}
                    variant={role.isActive ? "success" : "danger"}
                  >
                    {role.isActive ? "Active" : "Inactive"}
                  </Badge>
                ),
              },
              {
                label: "Requires 2FA",
                value: role.requires2fa ? (
                  <Badge variant="primary" pill>
                    Yes
                  </Badge>
                ) : (
                  "No"
                ),
              },
              {
                label: "Created",
                value: new Date(role.createdAt).toLocaleString(),
              },
              {
                label: "Updated",
                value: new Date(role.updatedAt).toLocaleString(),
              },
            ]}
          />
          <TagCard
            title={`Permissions (${role.permissions?.length || 0})`}
            emptyText="No permissions assigned"
            tags={
              role.permissions?.map((p) =>
                p.retired ? `${p.displayName} (retired)` : p.displayName
              ) || []
            }
            color="secondary"
          />
        </Col>
        <Col>
          <Card>
            <Col>
              <h3>Users with this Role ({usersData?.users.length || 0})</h3>
              <Table<RoleUser>
                rows={usersData?.users || []}
                columns={userColumns}
                emptyMessage="No users assigned to this role"
                maxHeight="25rem"
              />
            </Col>
          </Card>
        </Col>
      </Row>
    </Page>
  );
};
