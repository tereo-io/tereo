import useDownloadObject from "@/features/file-storage/api/objects/useDownloadObject";
import { faDownload } from "@fortawesome/free-solid-svg-icons";
import { IconButton } from "@kosmeo-ui/react";

interface DownloadObjectButtonProps {
  bucketName: string;
  object: {
    id: string;
  };
}

const DownloadObjectButton = ({
  bucketName,
  object,
}: DownloadObjectButtonProps) => {
  const { downloadObject } = useDownloadObject();

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    void downloadObject(bucketName, object.id);
  };

  return (
    <IconButton
      icon={faDownload}
      onClick={handleDownload}
      variant="primary"
      size="sm"
    />
  );
};

export default DownloadObjectButton;
