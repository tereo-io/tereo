import useRemoveRoleUser from "@/features/auth-admin/api/roles/useRemoveRoleUser";
import type { RoleUser } from "@/features/auth-admin/api/roles/types";
import { ConfirmationModal, IconButton } from "@kosmeo-ui/react";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";

interface RemoveUserFromRoleButtonProps {
  roleId: string;
  roleDisplayName: string;
  user: RoleUser;
}

const RemoveUserFromRoleButton = ({
  roleId,
  roleDisplayName,
  user,
}: RemoveUserFromRoleButtonProps) => {
  const [showConfirm, setShowConfirm] = useState(false);

  const removeUserMutation = useRemoveRoleUser();

  const handleRemoveUser = () => {
    removeUserMutation.mutate(
      { roleId, userId: user.id, organizationId: user.organizationId },
      { onSuccess: () => setShowConfirm(false) }
    );
  };

  return (
    <>
      <IconButton
        icon={faTrash}
        title="Remove"
        variant="danger"
        size="sm"
        onClick={() => setShowConfirm(true)}
      />
      <ConfirmationModal
        show={showConfirm}
        handleHide={() => setShowConfirm(false)}
        handleConfirm={handleRemoveUser}
        title="Remove User from Role"
        body={`Are you sure you want to remove "${user.email}" from the "${roleDisplayName}" role${
          user.organizationId ? " in this organization" : ""
        }?`}
        confirmButtonText={
          removeUserMutation.isPending ? "Removing..." : "Remove"
        }
      />
    </>
  );
};

export default RemoveUserFromRoleButton;
