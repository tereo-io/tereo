import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Button, IconButton, Spinner } from "@kosmeo-ui/react";
import formatBytes from "@/utils/formatBytes";
import { useState } from "react";
import "./styles.css";
import {
  faCheck,
  faChevronDown,
  faChevronUp,
  faFile,
  faTimes,
  faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";
import {
  useUploadTracker,
  type TrackedUpload,
} from "../hooks/useUploadTracker";

const StatusIndicator = ({
  status,
  onDismiss,
}: {
  status: TrackedUpload["status"];
  onDismiss: () => void;
}) => {
  if (status === "pending" || status === "uploading") {
    return <Spinner size="sm" />;
  }
  const isDone = status === "completed";
  return (
    <IconButton
      icon={isDone ? faCheck : faTriangleExclamation}
      variant={isDone ? "success" : "danger"}
      size="sm"
      shadow={false}
      fullWidth={false}
      onClick={onDismiss}
      aria-label="Dismiss"
    />
  );
};

export const UploadTracker = () => {
  const { uploads, dismiss, clearFinished, clearAll } = useUploadTracker();
  const [collapsed, setCollapsed] = useState(false);

  if (uploads.length === 0) return null;

  const inFlightCount = uploads.filter(
    (u) => u.status === "pending" || u.status === "uploading"
  ).length;
  const failedCount = uploads.filter((u) => u.status === "failed").length;
  const allDone = inFlightCount === 0;

  const headerLabel = allDone
    ? failedCount > 0
      ? `${failedCount} failed · ${uploads.length - failedCount} done`
      : `Uploaded ${uploads.length} file${uploads.length === 1 ? "" : "s"}`
    : `Uploading ${inFlightCount} of ${uploads.length}`;

  return (
    <aside className="t-upload-tracker" role="status" aria-live="polite">
      <header className="t-upload-tracker-header">
        <span className="t-upload-tracker-title">{headerLabel}</span>
        <div className="t-upload-tracker-header-actions">
          {allDone && (
            <Button
              variant="link"
              size="sm"
              shadow={false}
              fullWidth={false}
              onClick={clearFinished}
            >
              Clear
            </Button>
          )}
          <IconButton
            icon={collapsed ? faChevronUp : faChevronDown}
            variant="light"
            size="sm"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Expand" : "Collapse"}
          />
          <IconButton
            icon={faTimes}
            variant="light"
            size="sm"
            onClick={clearAll}
            aria-label="Dismiss"
          />
        </div>
      </header>
      {!collapsed && (
        <ul className="t-upload-tracker-list">
          {uploads.map((u) => (
            <li key={u.id} className="t-upload-tracker-row">
              <FontAwesomeIcon
                icon={faFile}
                className="t-upload-tracker-file-icon"
              />
              <div className="t-upload-tracker-body">
                <div className="t-upload-tracker-name" title={u.objectKey}>
                  {u.displayName}
                </div>
                <div className="t-upload-tracker-meta">
                  {formatBytes(String(u.sizeBytes))} · {u.bucketName}/
                  {u.objectKey}
                </div>
                {u.status === "failed" && u.errorMessage && (
                  <div
                    className="t-upload-tracker-error"
                    title={u.errorMessage}
                  >
                    {u.errorMessage}
                  </div>
                )}
              </div>
              <div className="t-upload-tracker-status">
                <StatusIndicator
                  status={u.status}
                  onDismiss={() => dismiss(u.id)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
};
