import { Button, Modal } from "@kosmeo-ui/react";

interface ProvisionedDialogProps {
  show: boolean;
  provisionedFrom: string | null;
  onClose: () => void;
}

export const ProvisionedDialog = ({
  show,
  provisionedFrom,
  onClose,
}: ProvisionedDialogProps) => (
  <Modal
    show={show}
    onClose={onClose}
    title="Set in provisioning"
    footerButtons={[
      <Button key="ok" onClick={onClose}>
        Close
      </Button>,
    ]}
  >
    <p>
      This branding is set in provisioning document{" "}
      <code>{provisionedFrom ?? "a provisioning document"}</code>. Change it
      there, then restart core or run <code>npm run cli -- provision</code>.
      Removing it from the document makes it editable here.
    </p>
  </Modal>
);
