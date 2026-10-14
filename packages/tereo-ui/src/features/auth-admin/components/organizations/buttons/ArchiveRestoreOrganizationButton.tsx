import useRestoreOrganization from "@/features/auth-admin/api/organizations/useRestoreOrganization";
import useArchiveOrganization from "@/features/auth-admin/api/organizations/useArchiveOrganization";
import type { Organization } from "@/features/auth-admin/api/organizations/types";
import { faBoxArchive, faBoxOpen } from "@fortawesome/free-solid-svg-icons";
import { ConfirmationModal, IconButton } from "@kosmeo-ui/react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useState } from "react";

interface ArchiveRestoreOrganizationButtonProps {
  organization: Organization;
}

// Archive and restore share the `archivedAt` marker, so one control flips
// between them. Archiving from the detail page returns to the list (archived
// rows are hidden by default); restoring keeps you on the now-visible record.
const ArchiveRestoreOrganizationButton = ({
  organization,
}: ArchiveRestoreOrganizationButtonProps) => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [showModal, setShowModal] = useState(false);

  const archiveMutation = useArchiveOrganization();
  const restoreMutation = useRestoreOrganization();

  const isArchived = organization.archivedAt !== null;
  const isPending = archiveMutation.isPending || restoreMutation.isPending;

  if (!hasPermission("organizations.archive")) return null;
  // Archiving requires the org to be deactivated first — nothing to show while
  // it is still active and not yet archived.
  if (!isArchived && organization.isActive) return null;

  const handleConfirm = () => {
    if (isArchived) {
      restoreMutation.mutate(organization.id, {
        onSuccess: () => setShowModal(false),
      });
    } else {
      archiveMutation.mutate(organization.id, {
        onSuccess: () => navigate("/auth-admin/organizations"),
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
        title={isArchived ? "Restore Organization" : "Archive Organization"}
        body={
          isArchived
            ? `Restore the organization "${organization.name}"? It returns to lists but remains inactive until reactivated.`
            : `Archive the organization "${organization.name}"? Archived organizations are hidden from lists and read-only; you can restore them later.`
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

export default ArchiveRestoreOrganizationButton;
