import { faShareNodes } from "@fortawesome/free-solid-svg-icons";
import CreateShareModal from "../modals/CreateShareModal";
import { IconButton } from "@kosmeo-ui/react";
import { useAuth } from "@/lib/auth";
import { useState } from "react";

interface ShareObjectButtonProps {
  bucketName: string;
  object: { id: string; key: string };
}

/**
 * Row-level "share" trigger — opens the CreateShareModal pre-seeded for the
 * given object. The share is a revocable row the user can password-protect,
 * cap and expire, not a raw presigned URL.
 */
const ShareObjectButton = ({ bucketName, object }: ShareObjectButtonProps) => {
  const { hasPermission } = useAuth();
  const [show, setShow] = useState(false);

  if (!hasPermission("file-service.shares.write")) return null;

  return (
    <>
      <IconButton
        icon={faShareNodes}
        onClick={(e) => {
          e.stopPropagation();
          setShow(true);
        }}
        variant="secondary"
        size="sm"
        aria-label={`Share ${object.key}`}
      />
      <CreateShareModal
        bucketName={bucketName}
        show={show}
        onClose={() => setShow(false)}
        seedObject={{ id: object.id, objectKey: object.key }}
      />
    </>
  );
};

export default ShareObjectButton;
