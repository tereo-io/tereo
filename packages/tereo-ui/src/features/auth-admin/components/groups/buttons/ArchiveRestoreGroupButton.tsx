import useRestoreGroup from "@/features/auth-admin/api/groups/useRestoreGroup";
import useArchiveGroup from "@/features/auth-admin/api/groups/useArchiveGroup";
import { faBoxArchive, faBoxOpen } from "@fortawesome/free-solid-svg-icons";
import type { Group } from "@/features/auth-admin/api/groups/types";
import { ConfirmationModal, IconButton } from "@kosmeo-ui/react";
import { useGroupAuthority } from "../useGroupAuthority";
import { useState } from "react";

interface ArchiveRestoreGroupButtonProps {
  group: Group;
}

// Archive and restore share the `archivedAt` marker, so one control flips
// between them. A provisioned group is archived only by provisioning.
const ArchiveRestoreGroupButton = ({
  group,
}: ArchiveRestoreGroupButtonProps) => {
  const [showModal, setShowModal] = useState(false);
  const { canArchive } = useGroupAuthority(group);
  const archiveMutation = useArchiveGroup();
  const restoreMutation = useRestoreGroup();

  const isArchived = group.archivedAt !== null;
  const isPending = archiveMutation.isPending || restoreMutation.isPending;

  if (!canArchive || group.definitionSource === "provisioned") return null;

  const handleConfirm = () => {
    const mutation = isArchived ? restoreMutation : archiveMutation;
    mutation.mutate(group.id, { onSuccess: () => setShowModal(false) });
  };

  return (
    <>
      <IconButton
        icon={isArchived ? faBoxOpen : faBoxArchive}
        title={isArchived ? "Restore" : "Archive"}
        variant="secondary"
        size="sm"
        onClick={() => setShowModal(true)}
      />
      <ConfirmationModal
        show={showModal}
        handleHide={() => setShowModal(false)}
        handleConfirm={handleConfirm}
        title={isArchived ? "Restore Group" : "Archive Group"}
        body={
          isArchived
            ? `Restore the group "${group.name}"? Its members get its roles again.`
            : `Archive the group "${group.name}"? Its members keep their membership but lose every role it gives; you can restore it later.`
        }
        confirmButtonText={
          isPending
            ? isArchived
              ? "Restoring..."
              : "Archiving..."
            : isArchived
              ? "Restore"
              : "Archive"
        }
      />
    </>
  );
};

export default ArchiveRestoreGroupButton;
