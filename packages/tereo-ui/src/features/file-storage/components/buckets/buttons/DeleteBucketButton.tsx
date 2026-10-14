import useDeleteBucket from "@/features/file-storage/api/buckets/useDeleteBucket";
import type { Bucket } from "@/features/file-storage/api/buckets/types";
import { Alert, Modal, Button, IconButton } from "@kosmeo-ui/react";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";
import "../styles.css";

interface DeleteBucketButtonProps {
  bucket: Bucket;
  onDelete: () => void;
}

const DeleteBucketButton = ({ bucket, onDelete }: DeleteBucketButtonProps) => {
  const [showConfirm, setShowConfirm] = useState(false);
  const { mutate: deleteBucket, isPending } = useDeleteBucket();

  const handleDelete = () => {
    deleteBucket(bucket.name, {
      onSuccess: () => {
        setShowConfirm(false);
        onDelete();
      },
    });
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
        title="Delete Bucket"
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
          Are you sure you want to delete bucket <strong>{bucket.name}</strong>?
        </p>
        <Alert variant="danger">
          This action cannot be undone. All objects in this bucket will be
          deleted.
        </Alert>
      </Modal>
    </>
  );
};

export default DeleteBucketButton;
