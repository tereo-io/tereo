import { useUploadTracker } from "@/features/file-storage/hooks/useUploadTracker";
import { faFolderPlus, faFolderOpen } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useEffect, useMemo, useState } from "react";
import FolderTreePicker from "../FolderTreePicker";
import formatBytes from "@/utils/formatBytes";
import "../styles.css";
import {
  BorderedSection,
  Button,
  Col,
  FileUpload,
  FormError,
  IconButton,
  Modal,
} from "@kosmeo-ui/react";

interface UploadObjectModalProps {
  bucketName: string;
  show: boolean;
  /** Optional prefix to pre-fill (used by the tree view so uploads land in the current folder). */
  defaultPrefix?: string;
  /**
   * Files picked before the modal opened — e.g. the tree's "Upload Files" /
   * "Upload Folder" buttons fire the OS picker inline and hand the results
   * over. Seeds the modal's file list on open.
   */
  initialFiles?: File[];
  onUpload: () => void;
  onClose: () => void;
}

const UploadObjectModal = ({
  bucketName,
  show,
  defaultPrefix,
  initialFiles,
  onUpload,
  onClose,
}: UploadObjectModalProps) => {
  const { enqueueUploads } = useUploadTracker();
  const initialPrefix = defaultPrefix ?? "";
  const [folder, setFolder] = useState(initialPrefix);
  const [files, setFiles] = useState<File[] | null>(null);
  const [error, setError] = useState("");
  // Client-only folders the user created via "New folder". They don't exist on
  // the server until an upload lands in them — folders are implicit in object
  // keys. The picker merges these with fetched prefixes so the user can drill
  // into a brand-new location. Directory-picked uploads intentionally do NOT
  // contribute here: their internal structure would collide with existing
  // folders of the same name and confuse the preview.
  const [virtualFolders, setVirtualFolders] = useState<Set<string>>(new Set());
  // Prefix under which a new folder is being created. Snapshotted at the
  // moment the "New folder" button is pressed so the pending row stays
  // anchored even if the user re-selects a different folder in the tree.
  const [creatingUnder, setCreatingUnder] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [createFolderError, setCreateFolderError] = useState("");

  // Re-seed state each time the modal opens so navigating between folders (or
  // reopening after close) lands uploads in the right place instead of
  // reusing stale state.
  useEffect(() => {
    if (show) {
      setFolder(initialPrefix);
      setFiles(initialFiles && initialFiles.length > 0 ? initialFiles : null);
      setError("");
      setVirtualFolders(new Set());
      setCreatingUnder(null);
      setNewFolderName("");
      setCreateFolderError("");
    }
  }, [show, initialPrefix, initialFiles]);

  const totalSizeBytes = useMemo(
    () => (files ?? []).reduce((sum, f) => sum + f.size, 0),
    [files]
  );

  // Detect a directory pick: every File carries a non-empty webkitRelativePath
  // when it came from the Upload Folder picker. Individual file picks leave
  // webkitRelativePath as an empty string.
  const isFolderMode =
    (files?.length ?? 0) > 0 &&
    (files ?? []).every((f) => !!f.webkitRelativePath);

  const handleConfirmCreate = () => {
    if (creatingUnder === null) return;
    const trimmed = newFolderName.trim();
    if (trimmed === "") {
      setCreateFolderError("Folder name is required");
      return;
    }
    if (trimmed.includes("/")) {
      setCreateFolderError("Folder name cannot contain '/'");
      return;
    }
    if (trimmed.includes("..")) {
      setCreateFolderError("Folder name cannot contain '..'");
      return;
    }
    if (!/^[a-zA-Z0-9_. -]+$/.test(trimmed)) {
      setCreateFolderError(
        "Folder name can only contain letters, numbers, spaces, _, ., and -"
      );
      return;
    }
    const newPrefix = `${creatingUnder}${trimmed}/`;
    setVirtualFolders((prev) => {
      const next = new Set(prev);
      next.add(newPrefix);
      return next;
    });
    setFolder(newPrefix);
    setError("");
    setCreatingUnder(null);
    setNewFolderName("");
    setCreateFolderError("");
  };

  const handleCancelCreate = () => {
    setCreatingUnder(null);
    setNewFolderName("");
    setCreateFolderError("");
  };

  const handleSubmit = () => {
    if (!files || files.length === 0) {
      setError("Please select at least one file to upload");
      return;
    }

    enqueueUploads(
      files.map((file) => ({
        file,
        bucketName,
        objectKey: `${folder}${file.webkitRelativePath || file.name}`,
        displayName: file.webkitRelativePath || file.name,
      }))
    );
    setFolder("");
    setFiles(null);
    setError("");
    setVirtualFolders(new Set());
    onUpload();
  };

  const handleClose = () => {
    setFolder("");
    setFiles(null);
    setError("");
    setVirtualFolders(new Set());
    setCreatingUnder(null);
    setNewFolderName("");
    setCreateFolderError("");
    onClose();
  };

  const handleFileSelect = (selectedFiles: File[] | null) => {
    setFiles(selectedFiles);
  };

  const fileCount = files?.length ?? 0;
  const uploadLabel = fileCount > 1 ? `Upload ${fileCount} files` : "Upload";

  return (
    <Modal
      show={show}
      onClose={handleClose}
      title={`Upload to ${bucketName}`}
      footerButtons={[
        <Button key="upload" onClick={handleSubmit}>
          {uploadLabel}
        </Button>,
        <Button key="cancel" variant="secondary" onClick={handleClose}>
          Cancel
        </Button>,
      ]}
    >
      <Col>
        <div className="t-folder-picker-section">
          <div className="t-folder-picker-header">
            <label className="t-folder-picker-label">Folder</label>
            <IconButton
              icon={faFolderPlus}
              variant="light"
              size="sm"
              onClick={() => setCreatingUnder(folder)}
              disabled={creatingUnder !== null}
            >
              New folder
            </IconButton>
          </div>
          <FolderTreePicker
            bucketName={bucketName}
            value={folder}
            onChange={(prefix) => {
              setFolder(prefix);
              setError("");
            }}
            virtualFolders={virtualFolders}
            creatingUnder={creatingUnder}
            newFolderName={newFolderName}
            createFolderError={createFolderError}
            onNewFolderNameChange={(name) => {
              setNewFolderName(name);
              setCreateFolderError("");
            }}
            onConfirmCreate={handleConfirmCreate}
            onCancelCreate={handleCancelCreate}
          />
        </div>
        <FileUpload
          key={
            initialFiles && initialFiles.length > 0
              ? `seeded-${initialFiles.length}-${initialFiles[0].name}`
              : "empty"
          }
          onFileSelect={handleFileSelect}
          multiple
          required
          allowDirectory
          initialFiles={initialFiles}
          renderFiles={
            isFolderMode
              ? ({ files: pickedFiles, onClear }) => {
                  const name =
                    pickedFiles[0]?.webkitRelativePath?.split("/")[0] ??
                    "folder";
                  const size = pickedFiles.reduce((s, f) => s + f.size, 0);
                  return (
                    <BorderedSection layout="row" gap="sm">
                      <FontAwesomeIcon
                        icon={faFolderOpen}
                        className="t-folder-summary-icon"
                      />
                      <div className="t-folder-summary-text">
                        <div className="t-folder-summary-name">{name}</div>
                        <div className="v-help-text">
                          {pickedFiles.length} file
                          {pickedFiles.length === 1 ? "" : "s"} ·{" "}
                          {formatBytes(String(size))}
                        </div>
                      </div>
                      <Button variant="danger" size="sm" onClick={onClear}>
                        Clear
                      </Button>
                    </BorderedSection>
                  );
                }
              : undefined
          }
        />
        {fileCount > 0 && !isFolderMode && (
          <div className="v-help-text">
            {fileCount} file{fileCount === 1 ? "" : "s"} ·{" "}
            {formatBytes(String(totalSizeBytes))}
          </div>
        )}
        {error && <FormError>{error}</FormError>}
      </Col>
    </Modal>
  );
};

export default UploadObjectModal;
