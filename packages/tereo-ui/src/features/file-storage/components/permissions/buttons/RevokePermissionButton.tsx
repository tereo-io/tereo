import useRevokePermission from "@/features/file-storage/api/permissions/useRevokePermission";
import type { BucketPermission } from "@/features/file-storage/api/permissions/types";
import { IconButton, Modal, Button } from "@kosmeo-ui/react";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";

interface RevokePermissionButtonProps {
  bucketName: string;
  permission: BucketPermission;
  onRevoke: () => void;
}

const RevokePermissionButton = ({
  bucketName,
  permission,
  onRevoke,
}: RevokePermissionButtonProps) => {
  const [showConfirm, setShowConfirm] = useState(false);
  const { mutate: revokePermission, isPending } =
    useRevokePermission(bucketName);

  const handleRevoke = () => {
    revokePermission(
      { bucketName, userId: permission.userId },
      {
        onSuccess: () => {
          setShowConfirm(false);
          onRevoke();
        },
      }
    );
  };

  return (
    <>
      <IconButton
        icon={faTrash}
        title="Revoke"
        onClick={() => setShowConfirm(true)}
        variant="danger"
        size="sm"
      />

      <Modal
        show={showConfirm}
        onClose={() => setShowConfirm(false)}
        title="Revoke Permission"
        footerButtons={[
          <Button
            key="revoke"
            variant="danger"
            onClick={handleRevoke}
            isLoading={isPending}
            disabled={isPending}
          >
            Revoke
          </Button>,
          <Button
            key="cancel"
            variant="secondary"
            onClick={() => setShowConfirm(false)}
            disabled={isPending}
          >
            Cancel
          </Button>,
        ]}
      >
        <p>
          Are you sure you want to revoke permissions for user{" "}
          <strong>
            {permission.userName || permission.userEmail || permission.userId}
          </strong>
          ?
        </p>
      </Modal>
    </>
  );
};

export default RevokePermissionButton;
