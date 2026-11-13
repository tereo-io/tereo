import useGroupSkippedMembers from "../../api/groups/useGroupSkippedMembers";
import ArchiveRestoreGroupButton from "./buttons/ArchiveRestoreGroupButton";
import RemoveGroupMemberButton from "./buttons/RemoveGroupMemberButton";
import { errorDescriptionOf, type CoreError } from "@/utils/apiErrors";
import UnlinkGroupScimButton from "./buttons/UnlinkGroupScimButton";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ProvisionedBadge } from "@/components/ProvisionedBadge";
import { formatDate, formatDateTime } from "@/utils/formatDate";
import useGroupMembers from "../../api/groups/useGroupMembers";
import useGroupRoles from "../../api/groups/useGroupRoles";
import { faLock } from "@fortawesome/free-solid-svg-icons";
import useDocumentTitle from "@/hooks/useDocumentTitle";
import { useGroupAuthority } from "./useGroupAuthority";
import GroupRolesModal from "./modals/GroupRolesModal";
import AddMembersModal from "./modals/AddMembersModal";
import EditGroupModal from "./modals/EditGroupModal";
import { PageHeader } from "@/components/PageHeader";
import { useParams, Link } from "react-router-dom";
import useGroup from "../../api/groups/useGroup";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import "./styles.css";
import type {
  GroupMember,
  GroupRole,
  GroupSkippedMember,
} from "../../api/groups/types";
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
  SectionHeader,
  Spinner,
  Table,
  Tabs,
  type TableColumn,
} from "@kosmeo-ui/react";

export const GroupDetail = () => {
  const { groupId } = useParams<{ groupId: string }>();
  const id = groupId ?? "";

  const { data: group, isLoading, error } = useGroup(id);
  const membersQuery = useGroupMembers(id);
  const hasSkipped = (group?.skippedMemberCount ?? 0) > 0;
  const skippedQuery = useGroupSkippedMembers(
    id,
    !!group?.managedBy && hasSkipped
  );
  const {
    data: roles,
    isSuccess: rolesLoaded,
    error: rolesError,
  } = useGroupRoles(id);
  const { canWrite } = useGroupAuthority(group);
  // An organization's admins reach this page without these: link only to
  // pages the viewer can open.
  const { hasPermission } = useAuth();
  const canReadUsers = hasPermission("users.read");
  const canReadRoles = hasPermission("roles.read");
  const canReadOrgs = hasPermission("organizations.read");
  const [tab, setTab] = useState("members");
  const [showAdd, setShowAdd] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showRoles, setShowRoles] = useState(false);

  useDocumentTitle(group?.name);

  const members = useMemo(
    () => membersQuery.data?.pages.flatMap((p) => p.data) ?? [],
    [membersQuery.data]
  );

  const skippedMembers = useMemo(
    () => skippedQuery.data?.pages.flatMap((p) => p.data) ?? [],
    [skippedQuery.data]
  );

  const provisioned = group?.definitionSource === "provisioned";
  const managedBy = group?.managedBy ?? null;
  const archived = !!group?.archivedAt;
  const groupName = group?.name ?? "";

  const memberColumns: TableColumn<GroupMember>[] = useMemo(
    () => [
      {
        title: "Email",
        dataKey: "email",
        cellElement: (member) =>
          canReadUsers ? (
            <Link to={`/auth-admin/users/${member.userId}`} className="v-link">
              {member.email}
            </Link>
          ) : (
            member.email
          ),
      },
      {
        title: "Name",
        dataKey: "name",
        cellElement: (member) => member.name || "-",
      },
      {
        title: "Status",
        dataKey: "isActive",
        cellElement: (member) => (
          <Badge
            size="sm"
            subtle={true}
            variant={member.isActive ? "success" : "danger"}
          >
            {member.isActive ? "Active" : "Inactive"}
          </Badge>
        ),
      },
      {
        title: "Added",
        dataKey: "addedAt",
        cellElement: (member) => formatDate(member.addedAt),
      },
      // Members stay editable on a provisioned group (and removable from an
      // archived one); a pushed group's change in the directory.
      ...(canWrite && !managedBy
        ? [
            {
              title: "Actions",
              width: "7rem",
              cellElement: (member: GroupMember) => (
                <RemoveGroupMemberButton
                  groupId={id}
                  groupName={groupName}
                  member={member}
                />
              ),
            },
          ]
        : []),
    ],
    [id, groupName, canWrite, managedBy, canReadUsers]
  );

  const skippedColumns: TableColumn<GroupSkippedMember>[] = useMemo(
    () => [
      { title: "Name", dataKey: "name", cellElement: (m) => m.name || "-" },
      { title: "Email", dataKey: "email" },
      {
        title: "Reason",
        dataKey: "reason",
        cellElement: (m) =>
          m.reason === "not_org_member"
            ? "Not a member of this organization"
            : m.reason,
      },
    ],
    []
  );

  const roleColumns: TableColumn<GroupRole>[] = useMemo(
    () => [
      {
        title: "Role",
        dataKey: "displayName",
        cellElement: (role) =>
          canReadRoles ? (
            <Link to={`/auth-admin/roles/${role.id}`} className="v-link">
              {role.displayName}
            </Link>
          ) : (
            role.displayName
          ),
      },
      { title: "Name", dataKey: "name" },
      {
        title: "Type",
        dataKey: "serviceId",
        cellElement: (role) => (role.serviceId ? "System" : "Custom"),
      },
    ],
    [canReadRoles]
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

  if (!group) {
    return (
      <Page padded fillHeight>
        {!error || (error as CoreError).response?.status === 404 ? (
          <EmptyState layout="block">Group not found</EmptyState>
        ) : (
          <Alert variant="danger">
            {errorDescriptionOf(error, "Could not load the group")}
          </Alert>
        )}
      </Page>
    );
  }

  return (
    <Page padded fillHeight>
      <PageHeader
        title={group.name}
        subtitle={`Group: ${group.slug}`}
        badges={
          <>
            {provisioned && (
              <>
                <FontAwesomeIcon icon={faLock} title="Locked" />
                <ProvisionedBadge />
              </>
            )}
            {managedBy && (
              <Badge size="sm" subtle variant="primary">
                Directory
              </Badge>
            )}
            {group.archivedAt && <Badge variant="warning">Archived</Badge>}
          </>
        }
        actions={[
          ...(canWrite && managedBy
            ? [
                <UnlinkGroupScimButton
                  key="unlink"
                  groupId={id}
                  providerName={managedBy.providerName}
                />,
              ]
            : []),
          ...(canWrite
            ? [
                <Button
                  key="edit"
                  size="sm"
                  variant="secondary"
                  disabled={provisioned || archived}
                  onClick={() => setShowEdit(true)}
                >
                  Edit
                </Button>,
              ]
            : []),
          provisioned ? (
            <Button key="archive" size="sm" variant="secondary" disabled>
              Archive
            </Button>
          ) : (
            <ArchiveRestoreGroupButton key="archive" group={group} />
          ),
        ]}
      />
      {group.unprovisionedAt && (
        <Alert variant="warning">
          No provisioning document declares this group any more; it retires
          soon.
        </Alert>
      )}
      <Row>
        <Col>
          <ListCard
            listTitle="Group Details"
            items={[
              { label: "Name", value: group.name },
              { label: "Slug", value: group.slug },
              { label: "Description", value: group.description || "-" },
              {
                label: "Scope",
                value: !group.organizationId ? (
                  "Global"
                ) : canReadOrgs ? (
                  <Link
                    to={`/auth-admin/organizations/${group.organizationId}`}
                    className="v-link"
                  >
                    Organization
                  </Link>
                ) : (
                  "Organization"
                ),
              },
              {
                label: "Source",
                value: provisioned
                  ? "Provisioned"
                  : managedBy
                    ? "Directory"
                    : "Local",
              },
              {
                label: "Status",
                value: (
                  <Badge
                    size="sm"
                    subtle={true}
                    variant={archived ? "warning" : "success"}
                  >
                    {archived ? "Archived" : "Active"}
                  </Badge>
                ),
              },
              { label: "Members", value: String(group.memberCount) },
              { label: "Created", value: formatDateTime(group.createdAt) },
              { label: "Updated", value: formatDateTime(group.updatedAt) },
            ]}
          />
        </Col>
        <Col>
          <Card>
            <Tabs
              active={tab}
              onChange={setTab}
              tabs={[
                {
                  key: "members",
                  label: `Members (${group.memberCount})`,
                  content: (
                    <Col>
                      <SectionHeader
                        title="Members"
                        actions={
                          managedBy ? (
                            <span className="v-muted-text">
                              Members are managed by {managedBy.providerName}.
                            </span>
                          ) : canWrite ? (
                            <Button
                              size="sm"
                              disabled={archived}
                              onClick={() => setShowAdd(true)}
                            >
                              Add members
                            </Button>
                          ) : undefined
                        }
                      />
                      {membersQuery.isError && members.length === 0 ? (
                        <Alert variant="danger">
                          {errorDescriptionOf(
                            membersQuery.error,
                            "Could not load the members"
                          )}
                        </Alert>
                      ) : (
                        <Table<GroupMember>
                          rows={members}
                          columns={memberColumns}
                          rowKey={(m) => m.userId}
                          emptyMessage="No members in this group"
                          maxHeight="30rem"
                        />
                      )}
                      {membersQuery.hasNextPage && (
                        <Button
                          size="sm"
                          variant="secondary"
                          isLoading={membersQuery.isFetchingNextPage}
                          onClick={() => membersQuery.fetchNextPage()}
                        >
                          Load more
                        </Button>
                      )}
                      {managedBy && hasSkipped && (
                        <>
                          <SectionHeader title="Skipped members" />
                          <p className="v-muted-text">
                            Add them to the organization, then push the group
                            again from the directory.
                          </p>
                          {skippedQuery.isError &&
                          skippedMembers.length === 0 ? (
                            <Alert variant="danger">
                              {errorDescriptionOf(
                                skippedQuery.error,
                                "Could not load the skipped members"
                              )}
                            </Alert>
                          ) : (
                            <Table<GroupSkippedMember>
                              rows={skippedMembers}
                              columns={skippedColumns}
                              rowKey={(m) => m.userId}
                              maxHeight="20rem"
                            />
                          )}
                          {skippedQuery.hasNextPage && (
                            <Button
                              size="sm"
                              variant="secondary"
                              isLoading={skippedQuery.isFetchingNextPage}
                              onClick={() => skippedQuery.fetchNextPage()}
                            >
                              Load more
                            </Button>
                          )}
                        </>
                      )}
                    </Col>
                  ),
                },
                {
                  key: "roles",
                  label: `Roles (${roles?.length ?? 0})`,
                  content: (
                    <Col>
                      <SectionHeader
                        title="Roles"
                        actions={
                          canWrite ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={provisioned || archived || !rolesLoaded}
                              onClick={() => setShowRoles(true)}
                            >
                              Edit roles
                            </Button>
                          ) : undefined
                        }
                      />
                      {rolesError ? (
                        <Alert variant="danger">
                          {errorDescriptionOf(
                            rolesError,
                            "Could not load the roles"
                          )}
                        </Alert>
                      ) : (
                        <Table<GroupRole>
                          rows={roles ?? []}
                          columns={roleColumns}
                          rowKey={(r) => r.id}
                          emptyMessage="This group holds no roles"
                          maxHeight="30rem"
                        />
                      )}
                    </Col>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>
      <EditGroupModal
        group={group}
        show={showEdit}
        onClose={() => setShowEdit(false)}
      />
      <AddMembersModal
        groupId={id}
        memberIds={members.map((m) => m.userId)}
        show={showAdd}
        onAdd={() => setShowAdd(false)}
        onClose={() => setShowAdd(false)}
      />
      {showRoles && roles && (
        <GroupRolesModal
          groupId={id}
          organizational={!!group.organizationId}
          currentRoles={roles}
          providerName={managedBy?.providerName}
          show
          onClose={() => setShowRoles(false)}
        />
      )}
    </Page>
  );
};
