import useDeleteObject from "@/features/file-storage/api/objects/useDeleteObject";
import { Alert, IconButton, Modal, Button } from "@kosmeo-ui/react";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";
import "../styles.css";

interface DeleteObjectButtonProps {
  bucketName: string;
  object: {
    id: string;
    key: string;
  };
  onDelete: () => void;
}

const DeleteObjectButton = ({
  bucketName,
  object,
  onDelete,
}: DeleteObjectButtonProps) => {
  const [showConfirm, setShowConfirm] = useState(false);
  const { mutate: deleteObject, isPending } = useDeleteObject(bucketName);

  const handleDelete = () => {
    deleteObject(
      { bucketName, id: object.id, objectKey: object.key },
      {
        onSuccess: () => {
          setShowConfirm(false);
          onDelete();
        },
      }
    );
  };

  return (
    <>
      <IconButton
        icon={faTrash}
        title="Delete"
        onClick={(e) => {
          e.stopPropagation();
          setShowConfirm(true);
        }}
        variant="danger"
        size="sm"
      />

      <Modal
        show={showConfirm}
        onClose={() => setShowConfirm(false)}
        title="Delete Object"
        footerButtons={[
          <Button
            key="delete"
            variant="danger"
            onClick={handleDelete}
            isLoading={isPending}
            disabled={isPending}
          >
            Delete
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
          Are you sure you want to delete object{" "}
          <strong>{decodeURIComponent(object.key)}</strong>?
        </p>
        <Alert variant="danger">This action cannot be undone.</Alert>
      </Modal>
    </>
  );
};

export default DeleteObjectButton;
