import useSetMemberOrgRoles from "@/features/auth-admin/api/organizations/useSetMemberOrgRoles";
import useMemberOrgRoles from "@/features/auth-admin/api/organizations/useMemberOrgRoles";
import type { OrganizationMember } from "@/features/auth-admin/api/organizations/types";
import { orgAssignableRoles } from "@/features/auth-admin/api/roles/orgAssignable";
import useAllRoles from "@/features/auth-admin/api/roles/useAllRoles";
import { RolesReadRequired } from "../../roles/RolesReadRequired";
import { faUserShield } from "@fortawesome/free-solid-svg-icons";
import { useGroupAccess } from "../../groups/useGroupAuthority";
import { errorDescriptionOf } from "@/utils/apiErrors";
import { Link } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useState } from "react";
import "../../groups/styles.css";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
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
  const { hasPermission } = useAuth();
  const mayListRoles = hasPermission("roles.read");
  const {
    data: roles,
    isLoading: rolesLoading,
    isError: rolesFailed,
    error: rolesError,
  } = useAllRoles(showModal && mayListRoles);
  const { mutate, isPending } = useSetMemberOrgRoles(orgId);
  const { canRead: canReadGroup } = useGroupAccess();
  // Empty when core withholds them (the viewer may not read the org's groups).
  const groupRoles = current?.groupRoles ?? [];

  const heldRoles = current?.roles ?? [];
  const held = new Set(heldRoles.map((r) => r.id));
  const customRoles = orgAssignableRoles(roles ?? [], held);
  const assignable = new Set(customRoles.map((r) => r.id));
  // A held role that can't be offered (archived, inactive) is sent back as
  // it is: the PUT replaces the whole set of direct roles.
  const locked = heldRoles.filter((r) => !assignable.has(r.id));
  const values = (selected ?? heldRoles.map((r) => r.id)).filter((id) =>
    assignable.has(id)
  );
  const canSave = mayListRoles && !!roles && !!current;

  const handleClose = () => {
    setShowModal(false);
    setSelected(null);
  };

  const handleSave = () => {
    mutate(
      {
        userId: member.user.id,
        roleIds: [...values, ...locked.map((r) => r.id)],
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
            disabled={isPending || !canSave}
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
          {!mayListRoles ? (
            <RolesReadRequired />
          ) : currentLoading || rolesLoading ? (
            <Spinner size="md" />
          ) : rolesFailed ? (
            <Alert variant="danger">
              {errorDescriptionOf(rolesError, "Could not load the roles")}
            </Alert>
          ) : (
            <>
              {customRoles.length === 0 ? (
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
              {locked.map((role) => (
                <Checkbox
                  key={role.id}
                  labelLocation="right"
                  label={`${role.displayName} (archived or inactive)`}
                  checked
                  disabled
                  onChange={() => undefined}
                />
              ))}
            </>
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
