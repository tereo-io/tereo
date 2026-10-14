import triggerArchiveDownload from "@/features/file-storage/api/archives/triggerArchiveDownload";
import useCreateArchive from "@/features/file-storage/api/archives/useCreateArchive";
import { faDownload } from "@fortawesome/free-solid-svg-icons";
import { IconButton } from "@kosmeo-ui/react";
import { toast } from "react-toastify";

interface DownloadFolderButtonProps {
  bucketName: string;
  /** Full prefix (ending in the delimiter, e.g. "images/2024/"). */
  prefix: string;
  /** Shown in toasts + derives the fallback archive filename. */
  label: string;
  /** Object count from the prefix listing — used to warn on very large folders. */
  objectCount?: number;
}

/**
 * Per-folder-row archive download. Hits POST /buckets/:name/archives, then
 * triggers a native anchor-click on the returned presigned URL so the
 * browser handles the streaming zip with the server-provided filename.
 */
const DownloadFolderButton = ({
  bucketName,
  prefix,
  label,
  objectCount,
}: DownloadFolderButtonProps) => {
  const { mutate, isPending } = useCreateArchive(bucketName);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    mutate(
      { prefix, format: "zip" },
      {
        onSuccess: (data) => {
          triggerArchiveDownload(data.url);
          toast.success(
            `Downloading ${data.objectCount.toLocaleString()} file${
              data.objectCount === 1 ? "" : "s"
            } as ${data.filename}`
          );
        },
      }
    );
  };

  return (
    <IconButton
      icon={faDownload}
      onClick={handleClick}
      variant="primary"
      size="sm"
      disabled={isPending || objectCount === 0}
      aria-label={`Download folder ${label} as zip`}
    />
  );
};

export default DownloadFolderButton;
