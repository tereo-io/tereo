import useRegenerateAccountRecoveryCodes from "@/features/auth-admin/api/account/useRegenerateAccountRecoveryCodes";
import useAccountProfile from "@/features/auth-admin/api/account/useAccountProfile";
import { isReauthRequired, restartLoginFresh } from "@/features/auth";
import { toast } from "react-toastify";
import { AxiosError } from "axios";
import { useState } from "react";
import {
  Alert,
  Button,
  Col,
  Input,
  Modal,
  RecoveryCodeGrid,
} from "@kosmeo-ui/react";

const ACCOUNT_PATH = "/account";

const RegenerateRecoveryCodesButton = () => {
  const [generatedCodes, setGeneratedCodes] = useState<string[] | null>(null);
  const [showRegenCodesModal, setShowRegenCodesModal] = useState(false);
  const [totpError, setTotpError] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");

  const { data: profile } = useAccountProfile();

  const regenerateCodesMutation = useRegenerateAccountRecoveryCodes();

  const handleCloseRegenCodesModal = () => {
    setShowRegenCodesModal(false);
    setGeneratedCodes(null);
    setTotpCode("");
    setTotpError(null);
  };

  const handleCopyAllCodes = () => {
    if (!generatedCodes) return;
    navigator.clipboard.writeText(generatedCodes.join("\n"));
    toast.success("Recovery codes copied to clipboard");
  };

  const handleRegenerateRecoveryCodes = () => {
    if (totpCode.length !== 6) {
      setTotpError("Please enter a 6-digit code");
      return;
    }

    regenerateCodesMutation.mutate(
      { totpCode },
      {
        onSuccess: (data) => {
          setGeneratedCodes(data.recoveryCodes);
          setTotpCode("");
          setTotpError(null);
        },
        onError: (error: unknown) => {
          // Core replaces recovery codes only on a login under 10 minutes old.
          if (isReauthRequired(error)) {
            toast.info("Please sign in again to confirm this change.");
            void restartLoginFresh(ACCOUNT_PATH);
            return;
          }
          const axiosError = error as AxiosError<{
            error_description?: string;
          }>;
          setTotpError(
            axiosError.response?.data?.error_description ||
              "Failed to regenerate codes"
          );
        },
      }
    );
  };

  if (!profile) return null;

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setShowRegenCodesModal(true)}
      >
        Regenerate Recovery Codes
      </Button>
      <Modal
        show={showRegenCodesModal}
        onClose={handleCloseRegenCodesModal}
        title="Regenerate Recovery Codes"
        footerButtons={
          generatedCodes
            ? [
                <Button
                  key="copy"
                  variant="secondary"
                  onClick={handleCopyAllCodes}
                >
                  Copy All
                </Button>,
                <Button
                  key="close"
                  variant="primary"
                  onClick={handleCloseRegenCodesModal}
                >
                  Done
                </Button>,
              ]
            : [
                <Button
                  key="cancel"
                  variant="secondary"
                  onClick={handleCloseRegenCodesModal}
                >
                  Cancel
                </Button>,
                <Button
                  key="confirm"
                  variant="primary"
                  onClick={handleRegenerateRecoveryCodes}
                  isLoading={regenerateCodesMutation.isPending}
                  disabled={totpCode.length !== 6}
                >
                  Generate New Codes
                </Button>,
              ]
        }
      >
        {generatedCodes ? (
          <Col>
            <Alert variant="warning">
              These codes will only be shown once. Save them in a secure
              location like a password manager.
            </Alert>
            <RecoveryCodeGrid codes={generatedCodes} />
          </Col>
        ) : (
          <Col>
            <Alert>
              You have {profile.totp.recoveryCodesRemaining} recovery codes
              remaining. Regenerating will invalidate all existing codes.
            </Alert>
            {totpError && <Alert variant="danger">{totpError}</Alert>}
            <p>
              To regenerate your recovery codes, please enter your current 2FA
              code from your authenticator app.
            </p>
            <Input
              label="Authenticator Code"
              type="text"
              autoComplete="one-time-code"
              value={totpCode}
              onChange={(e) => {
                const value = e.target.value.replace(/\D/g, "").slice(0, 6);
                setTotpCode(value);
                setTotpError(null);
              }}
              placeholder="000000"
            />
          </Col>
        )}
      </Modal>
    </>
  );
};

export default RegenerateRecoveryCodesButton;
