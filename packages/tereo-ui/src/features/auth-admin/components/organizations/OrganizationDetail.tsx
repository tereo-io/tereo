import ArchiveRestoreOrganizationButton from "./buttons/ArchiveRestoreOrganizationButton";
import useOrganizationMembers from "../../api/organizations/useOrganizationMembers";
import ManageMemberOrgRolesButton from "./buttons/ManageMemberOrgRolesButton";
import type { OrganizationMember } from "../../api/organizations/types";
import EditOrganizationButton from "./buttons/EditOrganizationButton";
import UpdateMemberRoleButton from "./buttons/UpdateMemberRoleButton";
import useOrganization from "../../api/organizations/useOrganization";
import RemoveMemberButton from "./buttons/RemoveMemberButton";
import useDocumentTitle from "@/hooks/useDocumentTitle";
import AddMemberModal from "./modals/AddMemberModal";
import { PageHeader } from "@/components/PageHeader";
import { formatDateTime } from "@/utils/formatDate";
import { useParams, Link } from "react-router-dom";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
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
  type TableColumn,
} from "@kosmeo-ui/react";

export const OrganizationDetail = () => {
  const { organizationId } = useParams<{ organizationId: string }>();
  const id = organizationId ?? "";

  const { data: organization, isLoading: orgLoading } = useOrganization(id);
  const { data: membersData } = useOrganizationMembers(id);
  const [showAddMember, setShowAddMember] = useState(false);
  const { hasPermission, organizations } = useAuth();

  useDocumentTitle(organization?.name);

  const isArchived = Boolean(organization?.archivedAt);

  // Core lets organizations.write, or the caller's role in this
  // organization, through: an owner may edit it, an admin or owner may
  // manage its members. Adding a member is organizations.write alone.
  const myRole = organizations.find((o) => o.id === id)?.memberRole;
  const canWrite = hasPermission("organizations.write");
  const canEdit = canWrite || myRole === "owner";
  const canManageMembers = canWrite || myRole === "owner" || myRole === "admin";

  const memberColumns: TableColumn<OrganizationMember>[] = useMemo(
    () => [
      {
        title: "Email",
        dataKey: "user",
        cellElement: (member) => (
          <Link to={`/auth-admin/users/${member.user.id}`} className="v-link">
            {member.user.email}
          </Link>
        ),
      },
      {
        title: "Name",
        dataKey: "user",
        cellElement: (member) => member.user.name || "-",
      },
      {
        title: "Role",
        dataKey: "memberRole",
        cellElement: (member) => (
          <Badge
            size="sm"
            subtle={true}
            variant={
              member.memberRole === "owner"
                ? "primary"
                : member.memberRole === "admin"
                  ? "warning"
                  : "secondary"
            }
          >
            {member.memberRole.charAt(0).toUpperCase() +
              member.memberRole.slice(1)}
          </Badge>
        ),
      },
      {
        title: "Status",
        dataKey: "user",
        cellElement: (member) => (
          <Badge
            size="sm"
            subtle={true}
            variant={member.user.isActive ? "success" : "danger"}
          >
            {member.user.isActive ? "Active" : "Inactive"}
          </Badge>
        ),
      },
      // Archived organizations are read-only: core 409s member mutations.
      ...(isArchived || !canManageMembers
        ? []
        : [
            {
              title: "Actions",
              width: "10rem",
              cellElement: (member: OrganizationMember) => (
                <Row size="sm">
                  <UpdateMemberRoleButton orgId={id} member={member} />
                  <ManageMemberOrgRolesButton orgId={id} member={member} />
                  <RemoveMemberButton orgId={id} member={member} />
                </Row>
              ),
            },
          ]),
    ],
    [id, isArchived, canManageMembers]
  );

  if (orgLoading) {
    return (
      <Page padded fillHeight>
        <Centered>
          <Spinner size="lg" />
        </Centered>
      </Page>
    );
  }

  if (!organization) {
    return (
      <Page padded fillHeight>
        <EmptyState layout="block">Organization not found</EmptyState>
      </Page>
    );
  }

  return (
    <Page padded fillHeight>
      <PageHeader
        title={organization.name}
        subtitle={organization.slug}
        badges={
          organization.archivedAt ? (
            <Badge variant="warning">Archived</Badge>
          ) : undefined
        }
        actions={[
          ...(organization.archivedAt || !canEdit
            ? []
            : [
                <EditOrganizationButton
                  key="edit"
                  organization={organization}
                />,
              ]),
          <ArchiveRestoreOrganizationButton
            key="archive"
            organization={organization}
          />,
        ]}
      />
      <Row>
        <Col>
          <ListCard
            listTitle="Organization Details"
            items={[
              { label: "ID", value: organization.id },
              { label: "Name", value: organization.name },
              { label: "Slug", value: organization.slug },
              { label: "Code", value: organization.code },
              {
                label: "Default",
                value: organization.isDefault ? "Yes" : "No",
              },
              {
                label: "Status",
                value: (
                  <Badge
                    size="sm"
                    subtle={true}
                    variant={organization.isActive ? "success" : "danger"}
                  >
                    {organization.isActive ? "Active" : "Inactive"}
                  </Badge>
                ),
              },
              {
                label: "Members",
                value: String(organization.memberCount),
              },
              {
                label: "Created",
                value: formatDateTime(organization.createdAt),
              },
              {
                label: "Updated",
                value: formatDateTime(organization.updatedAt),
              },
            ]}
          />
        </Col>
        <Col>
          <Card>
            <Col>
              <SectionHeader
                title={`Members (${membersData?.members.length || 0})`}
                actions={
                  isArchived || !canWrite ? undefined : (
                    <Button size="sm" onClick={() => setShowAddMember(true)}>
                      Add Member
                    </Button>
                  )
                }
              />
              <Table<OrganizationMember>
                rows={membersData?.members || []}
                columns={memberColumns}
                emptyMessage="No members in this organization"
                maxHeight="30rem"
              />
            </Col>
          </Card>
          <AddMemberModal
            orgId={id}
            members={membersData?.members || []}
            show={showAddMember}
            onAdd={() => setShowAddMember(false)}
            onClose={() => setShowAddMember(false)}
          />
        </Col>
      </Row>
    </Page>
  );
};
