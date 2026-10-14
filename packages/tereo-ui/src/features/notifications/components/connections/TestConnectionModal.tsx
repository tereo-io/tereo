import useTestConnection from "../../api/connections/useTestConnection";
import { errorMessage, type CoreError } from "../../api/errorMessage";
import { Alert, Button, Input, Modal } from "@kosmeo-ui/react";
import type { NotificationConnection } from "../../api/types";
import { useState } from "react";
import "../styles.css";

interface TestConnectionModalProps {
  show: boolean;
  connection: NotificationConnection | null;
  onClose: () => void;
}

/** Sends one message through the connection and shows the provider's answer. */
export const TestConnectionModal = ({
  show,
  connection,
  onClose,
}: TestConnectionModalProps) => {
  const [to, setTo] = useState("");
  const test = useTestConnection();

  const close = () => {
    test.reset();
    onClose();
  };

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!connection) return;
    test.mutate({ id: connection.id, to: to.trim() });
  };

  return (
    <Modal
      show={show}
      onClose={close}
      title={`Send test: ${connection?.displayName ?? ""}`}
      footerButtons={[
        <Button key="close" variant="secondary" onClick={close}>
          Close
        </Button>,
        <Button
          key="send"
          type="submit"
          form="test-notification-connection-form"
          isLoading={test.isPending}
        >
          Send test
        </Button>,
      ]}
    >
      <form id="test-notification-connection-form" onSubmit={send}>
        <Input
          label="Send to"
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          required
          max={320}
          placeholder="you@example.com"
          helperText="Sent synchronously with the stored credentials, even when the connection is disabled. Nothing is recorded in the log."
        />
      </form>
      <div className="t-notif-result" aria-live="polite">
        {test.data?.ok === true && (
          <Alert variant="success">
            Sent. Provider response:{" "}
            <span className="t-notif-mono">
              {test.data.providerResponse ?? "none"}
            </span>
          </Alert>
        )}
        {test.data?.ok === false && (
          <Alert variant="danger">{test.data.error}</Alert>
        )}
        {test.error && (
          <Alert variant="danger">
            {errorMessage(test.error as CoreError, "The test failed")}
          </Alert>
        )}
      </div>
    </Modal>
  );
};
