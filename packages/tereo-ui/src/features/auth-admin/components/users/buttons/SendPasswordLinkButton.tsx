import useIssuePasswordSetupLink from "@/features/auth-admin/api/guests/useIssuePasswordSetupLink";
import type { PasswordSetupLink } from "@/features/auth-admin/api/guests/types";
import { Button, Checkbox, Col, Modal, SecretDisplay } from "@kosmeo-ui/react";
import type { User } from "@/features/auth-admin/api/users/types";
import { formatDateTime } from "@/utils/formatDate";
import { useState } from "react";

interface SendPasswordLinkButtonProps {
  user: User;
}

const SendPasswordLinkButton = ({ user }: SendPasswordLinkButtonProps) => {
  const [show, setShow] = useState(false);
  const [notify, setNotify] = useState(true);
  const [link, setLink] = useState<PasswordSetupLink | null>(null);
  const issue = useIssuePasswordSetupLink();

  const close = () => {
    setShow(false);
    setLink(null);
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setShow(true)}>
        Send password link
      </Button>
      <Modal
        show={show}
        onClose={close}
        title="Password Setup Link"
        footerButtons={
          link
            ? [
                <Button key="done" onClick={close}>
                  Done
                </Button>,
              ]
            : [
                <Button key="cancel" variant="secondary" onClick={close}>
                  Cancel
                </Button>,
                <Button
                  key="send"
                  isLoading={issue.isPending}
                  onClick={() =>
                    issue.mutate(
                      { id: user.id, notify },
                      { onSuccess: setLink }
                    )
                  }
                >
                  Create link
                </Button>,
              ]
        }
      >
        <Col>
          {link ? (
            <>
              <p>
                Share this link with {user.email}. It works once and expires{" "}
                {formatDateTime(link.expiresAt)}; any earlier link no longer
                works.
              </p>
              <SecretDisplay value={link.url} />
            </>
          ) : (
            <>
              <p>
                Creates a fresh link for {user.email} to choose a password.
                Earlier links stop working.
              </p>
              <Checkbox
                label="Email the link to the guest"
                labelLocation="right"
                checked={notify}
                onChange={(e) => setNotify(e.target.checked)}
              />
            </>
          )}
        </Col>
      </Modal>
    </>
  );
};

export default SendPasswordLinkButton;
