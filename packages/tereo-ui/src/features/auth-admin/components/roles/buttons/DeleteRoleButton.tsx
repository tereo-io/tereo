import useDeleteRole from "@/features/auth-admin/api/roles/useDeleteRole";
import { ConfirmationModal, IconButton } from "@kosmeo-ui/react";
import { Role } from "@/features/auth-admin/api/roles/types";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useState } from "react";

interface DeleteRoleButtonProps {
  role: Role;
  /** Users holding the role, who lose it (and their sessions) on delete. */
  userCount: number;
}

const DeleteRoleButton = ({ role, userCount }: DeleteRoleButtonProps) => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [showModal, setShowModal] = useState(false);

  const deleteMutation = useDeleteRole();

  // System roles belong to the service that declares them; core refuses.
  if (role.isSystem) return null;
  if (!hasPermission("roles.delete")) return null;

  const handleConfirm = () => {
    deleteMutation.mutate(role.id, {
      onSuccess: () => navigate("/auth-admin/roles"),
      onSettled: () => setShowModal(false),
    });
  };

  const holders =
    userCount === 0
      ? "No users hold it."
      : `${userCount} ${userCount === 1 ? "user loses" : "users lose"} it and must sign in again.`;

  return (
    <>
      <IconButton
        icon={faTrash}
        title="Delete"
        variant="danger"
        size="sm"
        onClick={() => setShowModal(true)}
      />
      <ConfirmationModal
        show={showModal}
        handleHide={() => setShowModal(false)}
        handleConfirm={handleConfirm}
        title="Delete Role"
        body={`Permanently delete the role "${role.displayName}"? ${holders} This cannot be undone — archive the role instead to keep it restorable.`}
        confirmButtonText="Delete"
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

export default DeleteRoleButton;
