import useRestoreRole from "@/features/auth-admin/api/roles/useRestoreRole";
import useArchiveRole from "@/features/auth-admin/api/roles/useArchiveRole";
import { faBoxArchive, faBoxOpen } from "@fortawesome/free-solid-svg-icons";
import { ConfirmationModal, IconButton } from "@kosmeo-ui/react";
import { Role } from "@/features/auth-admin/api/roles/types";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useState } from "react";

interface ArchiveRestoreRoleButtonProps {
  role: Role;
}

// Archive and restore share the `archivedAt` marker, so one control flips
// between them. Archiving from the detail page returns to the list (archived
// rows are hidden by default); restoring keeps you on the now-visible record.
const ArchiveRestoreRoleButton = ({ role }: ArchiveRestoreRoleButtonProps) => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [showModal, setShowModal] = useState(false);

  const archiveMutation = useArchiveRole();
  const restoreMutation = useRestoreRole();

  const isArchived = role.archivedAt !== null;
  const isPending = archiveMutation.isPending || restoreMutation.isPending;

  // System roles can never be archived or restored.
  if (role.isSystem) return null;
  if (!hasPermission("roles.archive")) return null;
  // Archiving requires the role to be deactivated first — nothing to show while
  // it is still active and not yet archived.
  if (!isArchived && role.isActive) return null;

  const handleConfirm = () => {
    if (isArchived) {
      restoreMutation.mutate(role.id, {
        onSuccess: () => setShowModal(false),
      });
    } else {
      archiveMutation.mutate(role.id, {
        onSuccess: () => navigate("/auth-admin/roles"),
      });
    }
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
        title={isArchived ? "Restore Role" : "Archive Role"}
        body={
          isArchived
            ? `Restore the role "${role.displayName}"? It returns to lists but remains inactive until reactivated.`
            : `Archive the role "${role.displayName}"? Archived roles are hidden from lists and read-only; you can restore them later.`
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

export default ArchiveRestoreRoleButton;
