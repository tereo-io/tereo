import useObjectThumbnail from "@/features/file-storage/api/objects/useObjectThumbnail";
import ObjectImagePreviewModal from "../modals/ObjectImagePreviewModal";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFile } from "@fortawesome/free-solid-svg-icons";
import { useState, type MouseEvent } from "react";
import useOnScreen from "@/hooks/useOnScreen";
import { Button } from "@kosmeo-ui/react";

interface ObjectThumbnailProps {
  bucketName: string;
  objectKey: string;
  contentType: string;
}

/**
 * Renders a 128px WebP thumbnail for image objects and falls back to a file
 * icon for non-image content or while the server is still generating
 * thumbnails (404 from `?thumbnail=thumb`). Clicking an image opens a
 * full-size preview modal.
 *
 * The blob download is gated on IntersectionObserver visibility so a long
 * list doesn't fire hundreds of thumbnail requests for rows that may never
 * be scrolled into view.
 */
const ObjectThumbnail = ({
  bucketName,
  objectKey,
  contentType,
}: ObjectThumbnailProps) => {
  const [previewOpen, setPreviewOpen] = useState(false);
  const isImage = contentType.startsWith("image/");
  const { ref, isVisible } = useOnScreen();
  const { data: url } = useObjectThumbnail(
    bucketName,
    objectKey,
    contentType,
    "thumb",
    { enabled: isVisible }
  );

  const body = url ? (
    <img className="t-object-thumbnail" src={url} alt="" loading="lazy" />
  ) : (
    <FontAwesomeIcon icon={faFile} />
  );

  if (!isImage) return <span ref={ref}>{body}</span>;

  const openPreview = (e: MouseEvent) => {
    e.stopPropagation();
    setPreviewOpen(true);
  };

  return (
    <>
      <span ref={ref}>
        <Button
          variant="light"
          shadow={false}
          fullWidth={false}
          onClick={openPreview}
          aria-label={`Preview ${objectKey}`}
        >
          {body}
        </Button>
      </span>
      {previewOpen && (
        <ObjectImagePreviewModal
          bucketName={bucketName}
          objectKey={objectKey}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </>
  );
};

export default ObjectThumbnail;
