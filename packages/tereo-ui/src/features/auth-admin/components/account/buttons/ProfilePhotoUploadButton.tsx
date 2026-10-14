import useUploadPhoto from "@/features/auth-admin/api/account/useUploadPhoto";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCamera } from "@fortawesome/free-solid-svg-icons";
import { useEffect, useState } from "react";
import { AxiosError } from "axios";
import "../styles.css";
import {
  Alert,
  Button,
  FileUpload,
  ImagePreview,
  Modal,
} from "@kosmeo-ui/react";

interface ProfilePhotoUploadButtonProps {
  photoUrl: string | null;
  variant?: "icon" | "button";
}

const ProfilePhotoUploadButton = ({
  photoUrl,
  variant = "button",
}: ProfilePhotoUploadButtonProps) => {
  const [show, setShow] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const uploadPhotoMutation = useUploadPhoto();

  const handleFileSelect = (files: File[] | null) => {
    if (files && files.length > 0) {
      setSelectedFile(files[0]);
      setPreviewUrl(URL.createObjectURL(files[0]));
      setError(null);
    } else {
      setSelectedFile(null);
      setPreviewUrl(null);
    }
  };

  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const handleClose = () => {
    setShow(false);
    setSelectedFile(null);
    setPreviewUrl(null);
    setError(null);
  };

  const handleUpload = () => {
    if (!selectedFile) {
      setError("Please select an image to upload");
      return;
    }

    uploadPhotoMutation.mutate(selectedFile, {
      onSuccess: () => handleClose(),
      onError: (error: AxiosError<{ error_description?: string }>) => {
        setError(
          error.response?.data?.error_description || "Failed to upload photo"
        );
      },
    });
  };

  return (
    <>
      {variant === "icon" ? (
        <button
          className="t-profile-photo-edit-btn"
          onClick={() => setShow(true)}
          title="Change photo"
        >
          <FontAwesomeIcon icon={faCamera} />
        </button>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setShow(true)}>
          {photoUrl ? "Change Photo" : "Upload Photo"}
        </Button>
      )}

      <Modal
        show={show}
        onClose={handleClose}
        title="Upload Profile Photo"
        footerButtons={[
          <Button key="cancel" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>,
          <Button
            key="upload"
            variant="primary"
            onClick={handleUpload}
            isLoading={uploadPhotoMutation.isPending}
            disabled={!selectedFile}
          >
            Upload
          </Button>,
        ]}
      >
        <div className="t-profile-photo-upload-content">
          {error && <Alert variant="danger">{error}</Alert>}
          <FileUpload
            accept="image/*"
            onFileSelect={handleFileSelect}
            renderFiles={({ onClear, onChange }) =>
              previewUrl ? (
                <ImagePreview
                  previewUrls={[previewUrl]}
                  onClear={onClear}
                  onChange={onChange}
                />
              ) : null
            }
          />
          <p className="v-help-text">
            Supported formats: JPEG, PNG, GIF, WebP. Max size: 5MB.
          </p>
        </div>
      </Modal>
    </>
  );
};

export default ProfilePhotoUploadButton;
