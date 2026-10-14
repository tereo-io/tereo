import useRevokeSession from "@/features/auth-admin/api/users/useRevokeSession";
import { UserSession } from "@/features/auth-admin/api/users/types";
import { ConfirmationModal, IconButton } from "@kosmeo-ui/react";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";

interface RevokeSessionButtonProps {
  userId: string;
  session: UserSession;
}

const RevokeSessionButton = ({ userId, session }: RevokeSessionButtonProps) => {
  const [showConfirm, setShowConfirm] = useState(false);

  const revokeMutation = useRevokeSession();

  const handleRevokeSession = () => {
    revokeMutation.mutate(
      { userId, sessionId: session.id },
      { onSuccess: () => setShowConfirm(false) }
    );
  };

  return (
    <>
      <IconButton
        icon={faTrash}
        title="Revoke"
        variant="danger"
        size="sm"
        onClick={() => setShowConfirm(true)}
      />
      <ConfirmationModal
        show={showConfirm}
        handleHide={() => setShowConfirm(false)}
        handleConfirm={handleRevokeSession}
        title="Revoke Session"
        body={`Are you sure you want to revoke this session for "${session.clientName}"? The user will be logged out of this application.`}
        confirmButtonText={revokeMutation.isPending ? "Revoking..." : "Revoke"}
      />
    </>
  );
};

export default RevokeSessionButton;
