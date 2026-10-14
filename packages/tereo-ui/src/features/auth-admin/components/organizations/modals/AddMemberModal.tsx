import useAddMember from "@/features/auth-admin/api/organizations/useAddMember";
import { Button, Col, FormError, Input, Modal, Select } from "@kosmeo-ui/react";
import type { UserListItem } from "@/features/auth-admin/types/user";
import UserTypeahead from "../../users/UserTypeahead";
import { useAuth } from "@/lib/auth";
import { useState } from "react";
import type {
  MemberRole,
  OrganizationMember,
} from "@/features/auth-admin/api/organizations/types";

interface AddMemberModalProps {
  orgId: string;
  members: OrganizationMember[];
  show: boolean;
  onAdd: () => void;
  onClose: () => void;
}

const AddMemberModal = ({
  orgId,
  members,
  show,
  onAdd,
  onClose,
}: AddMemberModalProps) => {
  const { hasPermission } = useAuth();
  const { mutate: addMember, isPending } = useAddMember(orgId);
  // Searching users is `/v1/admin/users`, which needs users.read. An
  // organization admin without it enters the user's id; core checks it.
  const canSearchUsers = hasPermission("users.read");
  const [selectedUser, setSelectedUser] = useState<UserListItem | null>(null);
  const [manualUserId, setManualUserId] = useState("");
  const [memberRole, setMemberRole] = useState<MemberRole>("member");
  const [userError, setUserError] = useState("");

  const reset = () => {
    setSelectedUser(null);
    setManualUserId("");
    setMemberRole("member");
    setUserError("");
  };

  const handleSubmit = () => {
    const userId = canSearchUsers ? selectedUser?.id : manualUserId.trim();
    if (!userId) {
      setUserError(
        canSearchUsers ? "Please select a user" : "Please enter a user ID"
      );
      return;
    }
    if (members.some((m) => m.user.id === userId)) {
      setUserError("Already a member of this organization");
      return;
    }

    addMember(
      { userId, memberRole },
      {
        onSuccess: () => {
          reset();
          onAdd();
        },
      }
    );
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  return (
    <Modal
      show={show}
      onClose={handleClose}
      title="Add Member"
      footerButtons={[
        <Button
          key="add"
          onClick={handleSubmit}
          isLoading={isPending}
          disabled={isPending}
        >
          Add Member
        </Button>,
        <Button
          key="cancel"
          variant="secondary"
          onClick={handleClose}
          disabled={isPending}
        >
          Cancel
        </Button>,
      ]}
    >
      <Col size="md">
        {canSearchUsers ? (
          <UserTypeahead
            value={selectedUser}
            onSelect={(user) => {
              setSelectedUser(user);
              if (user) setUserError("");
            }}
            required
          />
        ) : (
          <Input
            label="User ID"
            value={manualUserId}
            onChange={(e) => {
              setManualUserId(e.target.value);
              setUserError("");
            }}
            placeholder="User UUID"
            required
          />
        )}
        {userError && <FormError>{userError}</FormError>}
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
  );
};

export default AddMemberModal;
