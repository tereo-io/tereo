import useUpdateMemberRole from "@/features/auth-admin/api/organizations/useUpdateMemberRole";
import { Col, Modal, Button, Select, IconButton } from "@kosmeo-ui/react";
import { faPencil } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";
import type {
  MemberRole,
  OrganizationMember,
} from "@/features/auth-admin/api/organizations/types";

interface UpdateMemberRoleButtonProps {
  orgId: string;
  member: OrganizationMember;
}

const UpdateMemberRoleButton = ({
  orgId,
  member,
}: UpdateMemberRoleButtonProps) => {
  const [showModal, setShowModal] = useState(false);
  const [memberRole, setMemberRole] = useState<MemberRole>(member.memberRole);
  const { mutate: updateRole, isPending } = useUpdateMemberRole(orgId);

  const handleOpen = () => {
    setMemberRole(member.memberRole);
    setShowModal(true);
  };

  const handleSubmit = () => {
    if (memberRole === member.memberRole) {
      setShowModal(false);
      return;
    }

    updateRole(
      { userId: member.user.id, updateData: { memberRole } },
      { onSuccess: () => setShowModal(false) }
    );
  };

  return (
    <>
      <IconButton
        icon={faPencil}
        title="Change role"
        size="sm"
        variant="secondary"
        onClick={handleOpen}
      />
      <Modal
        show={showModal}
        onClose={() => setShowModal(false)}
        title="Change Member Role"
        footerButtons={[
          <Button
            key="save"
            onClick={handleSubmit}
            isLoading={isPending}
            disabled={isPending}
          >
            Update Role
          </Button>,
          <Button
            key="cancel"
            variant="secondary"
            onClick={() => setShowModal(false)}
            disabled={isPending}
          >
            Cancel
          </Button>,
        ]}
      >
        <Col size="md">
          <p>
            Change role for <strong>{member.user.email}</strong>
          </p>
          <Select
            label="Role"
            value={memberRole}
            options={[
              { value: "owner", label: "Owner" },
              { value: "admin", label: "Admin" },
              { value: "member", label: "Member" },
            ]}
            onChange={(value) => setMemberRole(value as MemberRole)}
          />
        </Col>
      </Modal>
    </>
  );
};

export default UpdateMemberRoleButton;
