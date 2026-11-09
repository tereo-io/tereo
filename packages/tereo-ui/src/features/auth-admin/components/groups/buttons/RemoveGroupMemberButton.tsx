import useRemoveGroupMember from "@/features/auth-admin/api/groups/useRemoveGroupMember";
import type { GroupMember } from "@/features/auth-admin/api/groups/types";
import { ConfirmationModal, IconButton } from "@kosmeo-ui/react";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";

interface RemoveGroupMemberButtonProps {
  groupId: string;
  groupName: string;
  member: GroupMember;
}

const RemoveGroupMemberButton = ({
  groupId,
  groupName,
  member,
}: RemoveGroupMemberButtonProps) => {
  const [showConfirm, setShowConfirm] = useState(false);
  const removeMutation = useRemoveGroupMember(groupId);

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
        handleConfirm={() =>
          removeMutation.mutate(member.userId, {
            onSuccess: () => setShowConfirm(false),
          })
        }
        title="Remove Member"
        body={`Remove "${member.email}" from the group "${groupName}"? They lose every role the group gives.`}
        confirmButtonText={removeMutation.isPending ? "Removing..." : "Remove"}
      />
    </>
  );
};

export default RemoveGroupMemberButton;
