import useResetUserTotp from "@/features/auth-admin/api/users/useResetUserTotp";
import { Button, ConfirmationModal } from "@kosmeo-ui/react";
import { User } from "@/features/auth-admin/api/users/types";
import { useState } from "react";

interface ResetTotpButtonProps {
  user: User;
}

const ResetTotpButton = ({ user }: ResetTotpButtonProps) => {
  const [showResetModal, setShowResetModal] = useState(false);

  const resetTotpMutation = useResetUserTotp();

  const handleResetTotp = () => {
    resetTotpMutation.mutate(user.id, {
      onSuccess: () => setShowResetModal(false),
    });
  };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setShowResetModal(true)}
      >
        Reset two-factor
      </Button>
      <ConfirmationModal
        show={showResetModal}
        handleHide={() => setShowResetModal(false)}
        handleConfirm={handleResetTotp}
        title="Reset Two-Factor Authentication"
        body={`Reset 2FA for "${user.email}"? Their authenticator app and recovery codes stop working, they are signed out of every session, and they must set up two-factor authentication again.`}
        confirmButtonText={
          resetTotpMutation.isPending ? "Resetting..." : "Reset two-factor"
        }
      />
    </>
  );
};

export default ResetTotpButton;
