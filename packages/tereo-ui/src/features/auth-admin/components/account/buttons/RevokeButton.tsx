import useRevokeAccountSession from "@/features/auth-admin/api/account/useRevokeAccountSession";
import { AccountSession } from "@/features/auth-admin/api/account/types";
import { Button, ConfirmationModal } from "@kosmeo-ui/react";
import { useState } from "react";

interface RevokeButtonProps {
  session: AccountSession;
}

const RevokeButton = (props: RevokeButtonProps) => {
  const [sessionToRevoke, setSessionToRevoke] = useState<AccountSession | null>(
    null
  );

  const revokeMutation = useRevokeAccountSession();

  const handleRevokeSession = () => {
    if (!sessionToRevoke) return;
    revokeMutation.mutate(sessionToRevoke.id, {
      onSuccess: () => setSessionToRevoke(null),
    });
  };
  return (
    <>
      <Button
        variant="danger"
        size="sm"
        onClick={() => setSessionToRevoke(props.session)}
      >
        Revoke
      </Button>
      <ConfirmationModal
        show={!!sessionToRevoke}
        handleHide={() => setSessionToRevoke(null)}
        handleConfirm={handleRevokeSession}
        title="Revoke Session"
        body={`Are you sure you want to revoke this session for "${sessionToRevoke?.clientName}"? You will be logged out of that application.`}
        confirmButtonText={revokeMutation.isPending ? "Revoking..." : "Revoke"}
      />
    </>
  );
};

export default RevokeButton;
