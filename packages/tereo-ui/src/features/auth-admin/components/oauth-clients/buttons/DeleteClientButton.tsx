import useDeleteClient from "@/features/auth-admin/api/oauth-clients/useDeleteClient";
import { OAuthClient } from "@/features/auth-admin/api/oauth-clients/types";
import { ConfirmationModal, IconButton } from "@kosmeo-ui/react";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { useNavigate } from "react-router-dom";
import { useState } from "react";

interface DeleteClientButtonProps {
  client: OAuthClient;
}

const DeleteClientButton = ({ client }: DeleteClientButtonProps) => {
  const navigate = useNavigate();
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const deleteMutation = useDeleteClient();

  const handleDelete = () => {
    deleteMutation.mutate(client.id, {
      onSuccess: () => navigate("/auth-admin/oauth-clients"),
    });
  };

  return (
    <>
      <IconButton
        icon={faTrash}
        title="Delete"
        variant="danger"
        size="sm"
        onClick={() => setShowDeleteModal(true)}
      />
      <ConfirmationModal
        show={showDeleteModal}
        handleHide={() => setShowDeleteModal(false)}
        handleConfirm={handleDelete}
        title="Delete Client"
        body={`Are you sure you want to delete the client "${client.name}"? This action cannot be undone.`}
        confirmButtonText={deleteMutation.isPending ? "Deleting..." : "Delete"}
      />
    </>
  );
};

export default DeleteClientButton;
