import useInitiateAccountTotpSetup from "@/features/auth-admin/api/account/useInitiateAccountTotpSetup";
import useVerifyAccountTotpSetup from "@/features/auth-admin/api/account/useVerifyAccountTotpSetup";
import { isReauthRequired, restartLoginFresh } from "@/features/auth";
import { totpErrorMessage } from "./totpErrorMessage";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "react-toastify";
import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Col,
  Input,
  Modal,
  RecoveryCodeGrid,
  SecretDisplay,
  Spinner,
} from "@kosmeo-ui/react";

const ACCOUNT_PATH = "/account";

interface EnableTotpButtonProps {
  onOpenChange?: (open: boolean) => void;
}

const EnableTotpButton = ({ onOpenChange }: EnableTotpButtonProps) => {
  const [show, setShow] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const initiate = useInitiateAccountTotpSetup();
  const verify = useVerifyAccountTotpSetup();
  const setup = initiate.data;

  const start = () => {
    setShow(true);
    onOpenChange?.(true);
    initiate.mutate(undefined, {
      onError: (err) => {
        // Core enrolls a second factor only on a login under 10 minutes old.
        if (isReauthRequired(err)) {
          toast.info("Please sign in again to confirm this change.");
          void restartLoginFresh(ACCOUNT_PATH);
          return;
        }
        setError(totpErrorMessage(err, "Failed to start 2FA setup"));
      },
    });
  };

  // Once enabled, the codes are shown only here; closing needs the
  // acknowledgement, the same as on the login flow's setup page.
  const canClose = !recoveryCodes || acknowledged;

  const close = () => {
    if (!canClose) return;
    setShow(false);
    onOpenChange?.(false);
    setCode("");
    setError(null);
    setRecoveryCodes(null);
    setAcknowledged(false);
    initiate.reset();
    verify.reset();
  };

  const handleVerify = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!setup || code.length !== 6) return;
    verify.mutate(
      { setupToken: setup.setupToken, totpCode: code },
      {
        onSuccess: (data) => {
          setRecoveryCodes(data.recoveryCodes);
          toast.success("Two-factor authentication enabled");
        },
        onError: (err) =>
          setError(totpErrorMessage(err, "Verification failed")),
      }
    );
  };

  const copyCodes = () => {
    if (!recoveryCodes) return;
    navigator.clipboard.writeText(recoveryCodes.join("\n"));
    toast.success("Recovery codes copied to clipboard");
  };

  const footerButtons = recoveryCodes
    ? [
        <Button key="copy" variant="secondary" onClick={copyCodes}>
          Copy All
        </Button>,
        <Button key="done" onClick={close} disabled={!acknowledged}>
          Done
        </Button>,
      ]
    : [
        <Button key="cancel" variant="secondary" onClick={close}>
          Cancel
        </Button>,
        <Button
          key="verify"
          onClick={() => handleVerify()}
          isLoading={verify.isPending}
          disabled={!setup || code.length !== 6}
        >
          Verify and Enable
        </Button>,
      ];

  return (
    <>
      <Button variant="primary" size="sm" onClick={start}>
        Enable 2FA
      </Button>
      <Modal
        show={show}
        onClose={close}
        title={
          recoveryCodes
            ? "Save Your Recovery Codes"
            : "Enable Two-Factor Authentication"
        }
        footerButtons={footerButtons}
      >
        {recoveryCodes ? (
          <Col>
            <Alert variant="warning">
              These codes are shown only once, and each works once. Save them
              somewhere safe, like a password manager — you need one to sign in
              if you lose your authenticator.
            </Alert>
            <RecoveryCodeGrid codes={recoveryCodes} />
            <Checkbox
              id="totp-codes-acknowledged"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              label="I have saved my recovery codes"
              labelLocation="right"
            />
          </Col>
        ) : (
          <Col>
            {error && <Alert variant="danger">{error}</Alert>}
            {initiate.isPending && (
              <div className="t-totp-setup-loading">
                <Spinner size="lg" />
              </div>
            )}
            {setup && (
              <form onSubmit={handleVerify}>
                <Col>
                  <p>
                    Scan this code with an authenticator app such as Google
                    Authenticator, Authy or 1Password.
                  </p>
                  <div className="t-totp-qr">
                    <QRCodeSVG value={setup.qrCodeUri} size={200} />
                  </div>
                  <p className="v-help-text">
                    Can't scan it? Enter this key instead:
                  </p>
                  <SecretDisplay value={setup.secret} />
                  <Input
                    label="Code from your app"
                    type="text"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                      setError(null);
                    }}
                    placeholder="000000"
                  />
                </Col>
              </form>
            )}
          </Col>
        )}
      </Modal>
    </>
  );
};

export default EnableTotpButton;
