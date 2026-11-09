import useSetMemberOrgRoles from "@/features/auth-admin/api/organizations/useSetMemberOrgRoles";
import useMemberOrgRoles from "@/features/auth-admin/api/organizations/useMemberOrgRoles";
import type { OrganizationMember } from "@/features/auth-admin/api/organizations/types";
import { orgAssignableRoles } from "@/features/auth-admin/api/roles/orgAssignable";
import useAllRoles from "@/features/auth-admin/api/roles/useAllRoles";
import { faUserShield } from "@fortawesome/free-solid-svg-icons";
import { useGroupAccess } from "../../groups/useGroupAuthority";
import { Link } from "react-router-dom";
import { useState } from "react";
import "../../groups/styles.css";
import {
  Badge,
  Button,
  CheckboxGroup,
  Col,
  EmptyState,
  IconButton,
  Modal,
  Spinner,
} from "@kosmeo-ui/react";

interface ManageMemberOrgRolesButtonProps {
  orgId: string;
  member: OrganizationMember;
}

// Org-scoped role assignment. Roles held through the organization's groups
// are listed apart and read-only: the PUT sets direct assignments only.
const ManageMemberOrgRolesButton = ({
  orgId,
  member,
}: ManageMemberOrgRolesButtonProps) => {
  const [showModal, setShowModal] = useState(false);
  const [selected, setSelected] = useState<string[] | null>(null);

  const { data: current, isLoading: currentLoading } = useMemberOrgRoles(
    orgId,
    member.user.id,
    showModal
  );
  const { data: roles, isLoading: rolesLoading } = useAllRoles();
  const { mutate, isPending } = useSetMemberOrgRoles(orgId);
  const { canRead: canReadGroup } = useGroupAccess();
  const groupRoles = current?.groupRoles ?? [];

  const held = new Set(current?.roles.map((r) => r.id) ?? []);
  const customRoles = orgAssignableRoles(roles ?? [], held);
  const values = selected ?? current?.roles.map((r) => r.id) ?? [];

  const handleClose = () => {
    setShowModal(false);
    setSelected(null);
  };

  const handleSave = () => {
    const assignable = new Set(customRoles.map((r) => r.id));
    mutate(
      {
        userId: member.user.id,
        roleIds: values.filter((id) => assignable.has(id)),
      },
      { onSuccess: handleClose }
    );
  };

  return (
    <>
      <IconButton
        icon={faUserShield}
        title="Organization roles"
        size="sm"
        variant="secondary"
        onClick={() => setShowModal(true)}
      />
      <Modal
        show={showModal}
        onClose={handleClose}
        title="Organization Roles"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={handleClose}
            disabled={isPending}
          >
            Cancel
          </Button>,
          <Button
            key="save"
            onClick={handleSave}
            isLoading={isPending}
            disabled={isPending || currentLoading}
          >
            Save Roles
          </Button>,
        ]}
      >
        <Col size="md">
          <p>
            Roles for <strong>{member.user.email}</strong> within this
            organization. Only custom roles whose permissions are all
            org-assignable can be granted here; other roles are assigned under
            Users.
          </p>
          {currentLoading || rolesLoading ? (
            <Spinner size="md" />
          ) : customRoles.length === 0 ? (
            <EmptyState>
              No custom role can be granted within an organization
            </EmptyState>
          ) : (
            <CheckboxGroup
              name={`member-org-roles-${member.user.id}`}
              options={customRoles.map((role) => ({
                value: role.id,
                label: role.displayName,
              }))}
              values={values}
              onChange={setSelected}
            />
          )}
          {groupRoles.length > 0 && (
            <Col size="sm">
              <strong>Through this organization&apos;s groups</strong>
              <div className="t-role-chips">
                {groupRoles.map((r) => (
                  <Badge key={`${r.group.id}-${r.id}`} variant="secondary">
                    {r.displayName}{" "}
                    <span className="t-role-via">
                      via{" "}
                      {canReadGroup({ organizationId: orgId }) ? (
                        <Link
                          to={`/auth-admin/groups/${r.group.id}`}
                          className="v-link"
                        >
                          {r.group.name}
                        </Link>
                      ) : (
                        r.group.name
                      )}
                    </span>
                  </Badge>
                ))}
              </div>
            </Col>
          )}
        </Col>
      </Modal>
    </>
  );
};

export default ManageMemberOrgRolesButton;
