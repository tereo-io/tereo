import useRevokeAllAccountSessions from "@/features/auth-admin/api/account/useRevokeAllAccountSessions";
import useAccountSessions from "@/features/auth-admin/api/account/useAccountSessions";
import { Button, Checkbox, Modal } from "@kosmeo-ui/react";
import { useLogout } from "@/lib/auth";
import { useState } from "react";

const RevokeAllOtherSessionsButton = () => {
  const { mutate } = useLogout();

  const [showRevokeAllModal, setShowRevokeAllModal] = useState(false);
  const [includeCurrentSession, setIncludeCurrentSession] = useState(false);

  const { data: sessionsData } = useAccountSessions();

  const revokeAllMutation = useRevokeAllAccountSessions();

  const otherSessionsCount =
    sessionsData?.sessions.filter((s) => !s.isCurrent).length ?? 0;

  const handleRevokeAllSessions = () => {
    revokeAllMutation.mutate(
      { includeCurrentSession },
      {
        onSuccess: (data) => {
          setShowRevokeAllModal(false);
          setIncludeCurrentSession(false);
          if (data.currentSessionRevoked) mutate();
        },
      }
    );
  };

  const handleCloseRevokeAllModal = () => {
    setShowRevokeAllModal(false);
    setIncludeCurrentSession(false);
  };

  if (otherSessionsCount === 0) return null;
  return (
    <>
      <Button
        variant="danger"
        size="sm"
        onClick={() => setShowRevokeAllModal(true)}
      >
        Revoke All Other Sessions
      </Button>
      <Modal
        show={showRevokeAllModal}
        onClose={handleCloseRevokeAllModal}
        title="Revoke All Other Sessions"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={handleCloseRevokeAllModal}
          >
            Cancel
          </Button>,
          <Button
            key="confirm"
            variant="danger"
            onClick={handleRevokeAllSessions}
            isLoading={revokeAllMutation.isPending}
          >
            Revoke All
          </Button>,
        ]}
      >
        <p>
          Are you sure you want to revoke {otherSessionsCount} other session(s)?
          You will be logged out of all other devices and applications.
        </p>
        <Checkbox
          label="Also revoke current session (will log you out)"
          labelLocation="right"
          checked={includeCurrentSession}
          onChange={(e) => setIncludeCurrentSession(e.target.checked)}
        />
      </Modal>
    </>
  );
};

export default RevokeAllOtherSessionsButton;
