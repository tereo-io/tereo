import { Alert, Button, Modal, SecretDisplay } from "@kosmeo-ui/react";

interface ScimTokenModalProps {
  /** The token to show; the modal is closed while it is null. */
  token: string | null;
  onClose: () => void;
}

const ScimTokenModal = ({ token, onClose }: ScimTokenModalProps) => (
  <Modal
    show={token !== null}
    onClose={onClose}
    title="SCIM Token"
    size="lg"
    footerButtons={[
      <Button key="done" onClick={onClose}>
        Done
      </Button>,
    ]}
  >
    <Alert variant="warning">
      Copy this token now and give it to the provider. It is shown only once.
    </Alert>
    {token && <SecretDisplay value={token} />}
  </Modal>
);

export default ScimTokenModal;
