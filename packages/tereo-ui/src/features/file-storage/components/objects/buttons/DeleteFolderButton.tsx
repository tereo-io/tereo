import useBulkDeleteObjects from "@/features/file-storage/api/objects/useBulkDeleteObjects";
import { Alert, IconButton, Modal, Button, Input } from "@kosmeo-ui/react";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";

interface DeleteFolderButtonProps {
  bucketName: string;
  /** Full prefix (e.g. "images/2024/") — must end with the delimiter. */
  prefix: string;
  /** Just the folder segment, shown in the modal for recognition. */
  label: string;
  /** Count from the prefix listing — helps users gauge impact before confirming. */
  objectCount?: number;
  onDelete: () => void;
}

/**
 * Per-folder-row delete. Shows a typed-confirmation modal so a stray click
 * on the trash icon can't wipe a folder — users must retype the folder name
 * to enable the Delete button. Reuses `useBulkDeleteObjects`, which issues a
 * prefix-delete and surfaces `truncated=true` so large folders prompt a
 * follow-up invocation.
 */
const DeleteFolderButton = ({
  bucketName,
  prefix,
  label,
  objectCount,
  onDelete,
}: DeleteFolderButtonProps) => {
  const [show, setShow] = useState(false);
  const [typed, setTyped] = useState("");
  const { mutate: bulkDelete, isPending } = useBulkDeleteObjects(bucketName);

  const close = () => {
    setShow(false);
    setTyped("");
  };

  const handleConfirm = () => {
    bulkDelete(
      { prefix },
      {
        onSuccess: (data) => {
          close();
          onDelete();
          // If the server truncated (folder > 10k objects), the toast already
          // warns the user to re-run — the parent refetches and the residual
          // rows become visible for another pass.
          void data;
        },
      }
    );
  };

  return (
    <>
      <IconButton
        icon={faTrash}
        onClick={(e) => {
          e.stopPropagation();
          setShow(true);
        }}
        variant="danger"
        size="sm"
        aria-label={`Delete folder ${label}`}
      />

      <Modal
        show={show}
        onClose={close}
        title="Delete Folder"
        footerButtons={[
          <Button
            key="delete"
            variant="danger"
            onClick={handleConfirm}
            isLoading={isPending}
            disabled={isPending || typed !== label}
          >
            Delete Folder
          </Button>,
          <Button
            key="cancel"
            variant="secondary"
            onClick={close}
            disabled={isPending}
          >
            Cancel
          </Button>,
        ]}
      >
        <p>
          You are about to delete the folder{" "}
          <strong>{decodeURIComponent(prefix)}</strong> and{" "}
          {objectCount !== undefined ? (
            <>
              all <strong>{objectCount.toLocaleString()}</strong> object
              {objectCount === 1 ? "" : "s"} directly inside it (plus everything
              in its subfolders)
            </>
          ) : (
            <>everything under this prefix</>
          )}
          .
        </p>
        <Alert variant="danger">
          This action cannot be undone (except via object versioning, when
          enabled).
        </Alert>
        <p>
          Type <strong>{label}</strong> to confirm:
        </p>
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={label}
          disabled={isPending}
        />
      </Modal>
    </>
  );
};

export default DeleteFolderButton;
