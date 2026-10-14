import usePurgeNonCurrentVersions from "@/features/file-storage/api/objects/usePurgeNonCurrentVersions";
import { Alert, Modal, Button, IconButton } from "@kosmeo-ui/react";
import { faBroom } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";
import "../styles.css";

interface PurgeNonCurrentVersionsButtonProps {
  bucketName: string;
  onPurge?: () => void;
}

const PurgeNonCurrentVersionsButton = ({
  bucketName,
  onPurge,
}: PurgeNonCurrentVersionsButtonProps) => {
  const [showConfirm, setShowConfirm] = useState(false);
  const { mutate: purge, isPending } = usePurgeNonCurrentVersions(bucketName);

  const handlePurge = () => {
    purge(undefined, {
      onSuccess: () => {
        setShowConfirm(false);
        onPurge?.();
      },
    });
  };

  return (
    <>
      <IconButton
        icon={faBroom}
        onClick={(e) => {
          e.stopPropagation();
          setShowConfirm(true);
        }}
        variant="warning"
        size="sm"
      />

      <Modal
        show={showConfirm}
        onClose={() => setShowConfirm(false)}
        title="Purge non-current versions"
        footerButtons={[
          <Button
            key="purge"
            variant="danger"
            onClick={handlePurge}
            isLoading={isPending}
            disabled={isPending}
          >
            Purge
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
          Permanently delete every non-current version in bucket{" "}
          <strong>{bucketName}</strong>?
        </p>
        <p>
          The current version of each object is left untouched. Prior versions
          and delete-marker history will be removed and their storage reclaimed.
        </p>
        <Alert variant="warning">
          This action cannot be undone. Up to 10,000 versions are processed per
          run; if more remain you'll be prompted to run it again.
        </Alert>
      </Modal>
    </>
  );
};

export default PurgeNonCurrentVersionsButton;
