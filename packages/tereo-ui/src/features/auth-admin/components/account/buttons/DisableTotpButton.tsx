import useDisableAccountTotp from "@/features/auth-admin/api/account/useDisableAccountTotp";
import { isReauthRequired, restartLoginFresh } from "@/features/auth";
import { Alert, Button, Col, Input, Modal } from "@kosmeo-ui/react";
import { totpErrorMessage } from "./totpErrorMessage";
import { toast } from "react-toastify";
import { useState } from "react";

const ACCOUNT_PATH = "/account";

const DisableTotpButton = () => {
  const [show, setShow] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const disable = useDisableAccountTotp();

  const close = () => {
    setShow(false);
    setCode("");
    setError(null);
    disable.reset();
  };

  const handleDisable = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (code.length !== 6) return;
    disable.mutate(
      { totpCode: code },
      {
        onSuccess: close,
        onError: (err) => {
          // Core removes a second factor only on a login under 10 minutes old.
          if (isReauthRequired(err)) {
            toast.info("Please sign in again to confirm this change.");
            void restartLoginFresh(ACCOUNT_PATH);
            return;
          }
          setError(totpErrorMessage(err, "Failed to disable 2FA"));
        },
      }
    );
  };

  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setShow(true)}>
        Disable 2FA
      </Button>
      <Modal
        show={show}
        onClose={close}
        title="Disable Two-Factor Authentication"
        footerButtons={[
          <Button key="cancel" variant="secondary" onClick={close}>
            Cancel
          </Button>,
          <Button
            key="disable"
            variant="danger"
            onClick={() => handleDisable()}
            isLoading={disable.isPending}
            disabled={code.length !== 6}
          >
            Disable 2FA
          </Button>,
        ]}
      >
        <form onSubmit={handleDisable}>
          <Col>
            <Alert variant="warning">
              Your account will be protected by your password alone, and your
              recovery codes stop working.
            </Alert>
            {error && <Alert variant="danger">{error}</Alert>}
            <Input
              label="Code from your authenticator app"
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
      </Modal>
    </>
  );
};

export default DisableTotpButton;
