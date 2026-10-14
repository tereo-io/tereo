import useBulkDeleteObjects from "@/features/file-storage/api/objects/useBulkDeleteObjects";
import { Alert, Button, IconButton, Modal } from "@kosmeo-ui/react";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";

interface BulkDeleteObjectsButtonProps {
  bucketName: string;
  /** Selected folder prefixes — each gets a recursive prefix-delete. */
  selectedPrefixes: string[];
  /** Selected object ids — issued as a single id-delete. */
  selectedIds: string[];
  /** Human-readable summary of the selection (e.g. "2 folders and 3 objects"). */
  selectionSummary: string;
  /** Other actions (download/share) sharing this loading state to disable while busy. */
  disabled?: boolean;
  /** Fires after every delete settles (success or error) so the list can refresh. */
  onDeleted: () => void;
}

const BulkDeleteObjectsButton = ({
  bucketName,
  selectedPrefixes,
  selectedIds,
  selectionSummary,
  disabled,
  onDeleted,
}: BulkDeleteObjectsButtonProps) => {
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);
  const { mutateAsync: bulkDeleteAsync, isPending: bulkDeletePending } =
    useBulkDeleteObjects(bucketName);

  const handleBulkDeleteConfirm = async () => {
    // Selection may mix folders and objects. Issue one prefix-delete per
    // selected folder, then a single id-delete for all selected objects.
    // Errors surface via the hook's toast; `onDeleted` always runs to refresh
    // whatever did succeed, matching the per-row delete pattern.
    try {
      for (const prefix of selectedPrefixes) {
        await bulkDeleteAsync({ prefix });
      }
      if (selectedIds.length > 0) {
        await bulkDeleteAsync({ ids: selectedIds });
      }
    } finally {
      setShowBulkConfirm(false);
      onDeleted();
    }
  };

  return (
    <>
      <IconButton
        icon={faTrash}
        size="sm"
        variant="danger"
        onClick={() => setShowBulkConfirm(true)}
        disabled={disabled || bulkDeletePending}
      >
        Delete Selected
      </IconButton>

      <Modal
        show={showBulkConfirm}
        onClose={() => setShowBulkConfirm(false)}
        title="Delete Selected"
        footerButtons={[
          <Button
            key="delete"
            variant="danger"
            onClick={handleBulkDeleteConfirm}
            isLoading={bulkDeletePending}
            disabled={bulkDeletePending}
          >
            Delete
          </Button>,
          <Button
            key="cancel"
            variant="secondary"
            onClick={() => setShowBulkConfirm(false)}
            disabled={bulkDeletePending}
          >
            Cancel
          </Button>,
        ]}
      >
        <p>
          You are about to delete <strong>{selectionSummary}</strong>.
        </p>
        {selectedPrefixes.length > 0 && (
          <p>
            Folders will be wiped recursively — every object under each selected
            folder is removed.
          </p>
        )}
        <Alert variant="danger">
          This action cannot be undone (except via object versioning, when
          enabled).
        </Alert>
      </Modal>
    </>
  );
};

export default BulkDeleteObjectsButton;
