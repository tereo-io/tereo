import useChangePassword from "@/features/auth-admin/api/account/useChangePassword";
import { Alert, Button, Col, Input, Modal } from "@kosmeo-ui/react";
import { AxiosError } from "axios";
import { useState } from "react";

const ChangePasswordButton = () => {
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const changePasswordMutation = useChangePassword();

  const handleChangePassword = () => {
    if (!currentPassword) {
      setPasswordError("Current password is required");
      return;
    }
    if (newPassword.length < 12) {
      setPasswordError("New password must be at least 12 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match");
      return;
    }

    changePasswordMutation.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          handleCloseChangePasswordModal();
        },
        onError: (error: unknown) => {
          const axiosError = error as AxiosError<{
            error_description?: string;
          }>;
          setPasswordError(
            axiosError.response?.data?.error_description ||
              "Failed to change password"
          );
        },
      }
    );
  };

  const handleCloseChangePasswordModal = () => {
    setShowChangePasswordModal(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError(null);
  };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        fullWidth
        onClick={() => setShowChangePasswordModal(true)}
      >
        Change Password
      </Button>
      <Modal
        show={showChangePasswordModal}
        onClose={handleCloseChangePasswordModal}
        title="Change Password"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={handleCloseChangePasswordModal}
          >
            Cancel
          </Button>,
          <Button
            key="confirm"
            variant="primary"
            onClick={handleChangePassword}
            isLoading={changePasswordMutation.isPending}
          >
            Change Password
          </Button>,
        ]}
      >
        <Col>
          {passwordError && <Alert variant="danger">{passwordError}</Alert>}
          <Input
            label="Current Password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
              setPasswordError(null);
            }}
          />
          <Input
            label="New Password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setPasswordError(null);
            }}
          />
          <Input
            label="Confirm New Password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              setPasswordError(null);
            }}
          />
        </Col>
      </Modal>
    </>
  );
};

export default ChangePasswordButton;
