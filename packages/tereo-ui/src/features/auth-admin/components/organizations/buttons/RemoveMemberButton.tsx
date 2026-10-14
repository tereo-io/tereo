import type { OrganizationMember } from "@/features/auth-admin/api/organizations/types";
import useRemoveMember from "@/features/auth-admin/api/organizations/useRemoveMember";
import { ConfirmationModal, IconButton } from "@kosmeo-ui/react";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";

interface RemoveMemberButtonProps {
  orgId: string;
  member: OrganizationMember;
}

const RemoveMemberButton = ({ orgId, member }: RemoveMemberButtonProps) => {
  const [showConfirm, setShowConfirm] = useState(false);
  const { mutate: removeMember, isPending } = useRemoveMember(orgId);

  const handleRemove = () => {
    removeMember(member.user.id, {
      onSuccess: () => setShowConfirm(false),
    });
  };

  return (
    <>
      <IconButton
        icon={faTrash}
        title="Remove"
        onClick={() => setShowConfirm(true)}
        variant="danger"
        size="sm"
      />
      <ConfirmationModal
        show={showConfirm}
        handleHide={() => setShowConfirm(false)}
        handleConfirm={handleRemove}
        title="Remove Member"
        body={`Remove ${member.user.email} from this organization?`}
        confirmButtonText={isPending ? "Removing..." : "Remove"}
      />
    </>
  );
};

export default RemoveMemberButton;
