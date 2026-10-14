import encodeObjectKey from "@/features/file-storage/api/objects/encodeObjectKey";
import { Modal, Spinner } from "@kosmeo-ui/react";
import { useQuery } from "@tanstack/react-query";
import useObjectUrl from "@/hooks/useObjectUrl";
import { useAxios } from "@/lib/auth";

interface ObjectImagePreviewModalProps {
  bucketName: string;
  objectKey: string;
  onClose: () => void;
}

const ObjectImagePreviewModal = ({
  bucketName,
  objectKey,
  onClose,
}: ObjectImagePreviewModalProps) => {
  const axios = useAxios("fileService");

  const { data: blob, isLoading } = useQuery<Blob>({
    queryKey: ["object-full-image", bucketName, objectKey],
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    queryFn: async () => {
      const res = await axios.get(
        `/buckets/${bucketName}/objects/${encodeObjectKey(objectKey)}`,
        { responseType: "blob" }
      );
      return res.data as Blob;
    },
  });
  const url = useObjectUrl(blob);

  const filename = objectKey.split("/").pop() ?? objectKey;

  return (
    <Modal show onClose={onClose} title={filename} size="lg">
      <div className="t-object-preview-body">
        {isLoading || !url ? (
          <Spinner />
        ) : (
          <img className="t-object-preview-image" src={url} alt={filename} />
        )}
      </div>
    </Modal>
  );
};

export default ObjectImagePreviewModal;
