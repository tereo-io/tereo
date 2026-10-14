import { faShareNodes } from "@fortawesome/free-solid-svg-icons";
import CreateShareModal from "../modals/CreateShareModal";
import { IconButton } from "@kosmeo-ui/react";
import { useAuth } from "@/lib/auth";
import { useState } from "react";

interface ShareFolderButtonProps {
  bucketName: string;
  prefix: string;
  label: string;
  objectCount: number;
}

/**
 * Row-level "share" trigger on folder rows — opens the CreateShareModal
 * pre-seeded with the prefix. The server snapshots the contents at share
 * creation into an ArchiveRequest; the returned /shared/:token URL serves the
 * zip every time it's hit within its TTL.
 */
const ShareFolderButton = ({
  bucketName,
  prefix,
  label,
  objectCount,
}: ShareFolderButtonProps) => {
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
        disabled={objectCount === 0}
        aria-label={`Share folder ${label}`}
      />
      <CreateShareModal
        bucketName={bucketName}
        show={show}
        onClose={() => setShow(false)}
        seedPrefix={prefix}
      />
    </>
  );
};

export default ShareFolderButton;
