import useDeleteClient from "@/features/auth-admin/api/oauth-clients/useDeleteClient";
import { OAuthClient } from "@/features/auth-admin/api/oauth-clients/types";
import { ConfirmationModal, IconButton } from "@kosmeo-ui/react";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";

interface DeleteClientListButtonProps {
  client: OAuthClient;
}

const DeleteClientListButton = ({ client }: DeleteClientListButtonProps) => {
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const deleteMutation = useDeleteClient();

  const handleDelete = () => {
    deleteMutation.mutate(client.id, {
      onSuccess: () => setShowDeleteModal(false),
    });
  };

  return (
    <>
      <IconButton
        icon={faTrash}
        title="Delete"
        onClick={() => setShowDeleteModal(true)}
        variant="danger"
        size="sm"
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

export default DeleteClientListButton;
