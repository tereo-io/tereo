import useRevokeShare from "@/features/file-storage/api/shares/useRevokeShare";
import type { Share } from "@/features/file-storage/api/shares/types";
import { ConfirmationModal, IconButton } from "@kosmeo-ui/react";
import { faBan } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";

interface Props {
  bucketName: string;
  share: Share;
}

const RevokeShareButton = ({ bucketName, share }: Props) => {
  const [show, setShow] = useState(false);
  const { mutate: revokeShare, isPending } = useRevokeShare(bucketName);

  return (
    <>
      <IconButton
        icon={faBan}
        onClick={() => setShow(true)}
        variant="danger"
        size="sm"
        aria-label="Revoke share"
      />
      <ConfirmationModal
        show={show}
        handleHide={() => setShow(false)}
        handleConfirm={() =>
          revokeShare(share.id, { onSuccess: () => setShow(false) })
        }
        title="Revoke Share"
        body="Revoke this share? Recipients can no longer download."
        confirmButtonText="Revoke"
        isLoading={isPending}
      />
    </>
  );
};

export default RevokeShareButton;
