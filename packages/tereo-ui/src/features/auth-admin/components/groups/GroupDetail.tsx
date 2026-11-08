import ArchiveRestoreGroupButton from "./buttons/ArchiveRestoreGroupButton";
import RemoveGroupMemberButton from "./buttons/RemoveGroupMemberButton";
import type { GroupMember, GroupRole } from "../../api/groups/types";
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
import "./styles.css";
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

  const { data: group, isLoading } = useGroup(id);
  const membersQuery = useGroupMembers(id);
  const { data: roles, isSuccess: rolesLoaded } = useGroupRoles(id);
  const { canWrite } = useGroupAuthority(group);
  const [tab, setTab] = useState("members");
  const [showAdd, setShowAdd] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showRoles, setShowRoles] = useState(false);

  useDocumentTitle(group?.name);

  const members = useMemo(
    () => membersQuery.data?.pages.flatMap((p) => p.data) ?? [],
    [membersQuery.data]
  );

  const provisioned = group?.definitionSource === "provisioned";
  const archived = !!group?.archivedAt;
  const groupName = group?.name ?? "";

  const memberColumns: TableColumn<GroupMember>[] = useMemo(
    () => [
      {
        title: "Email",
        dataKey: "email",
        cellElement: (member) => (
          <Link to={`/auth-admin/users/${member.userId}`} className="v-link">
            {member.email}
          </Link>
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
      // archived one).
      ...(canWrite
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
    [id, groupName, canWrite]
  );

  const roleColumns: TableColumn<GroupRole>[] = useMemo(
    () => [
      {
        title: "Role",
        dataKey: "displayName",
        cellElement: (role) => (
          <Link to={`/auth-admin/roles/${role.id}`} className="v-link">
            {role.displayName}
          </Link>
        ),
      },
      { title: "Name", dataKey: "name" },
      {
        title: "Type",
        dataKey: "serviceId",
        cellElement: (role) => (role.serviceId ? "System" : "Custom"),
      },
    ],
    []
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
        <EmptyState layout="block">Group not found</EmptyState>
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
            {group.archivedAt && <Badge variant="warning">Archived</Badge>}
          </>
        }
        actions={[
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
                value: group.organizationId ? (
                  <Link
                    to={`/auth-admin/organizations/${group.organizationId}`}
                    className="v-link"
                  >
                    Organization
                  </Link>
                ) : (
                  "Global"
                ),
              },
              { label: "Source", value: provisioned ? "Provisioned" : "Local" },
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
                          canWrite ? (
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
                      <Table<GroupMember>
                        rows={members}
                        columns={memberColumns}
                        rowKey={(m) => m.userId}
                        emptyMessage="No members in this group"
                        maxHeight="30rem"
                      />
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
                      <Table<GroupRole>
                        rows={roles ?? []}
                        columns={roleColumns}
                        rowKey={(r) => r.id}
                        emptyMessage="This group holds no roles"
                        maxHeight="30rem"
                      />
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
          show
          onClose={() => setShowRoles(false)}
        />
      )}
    </Page>
  );
};
