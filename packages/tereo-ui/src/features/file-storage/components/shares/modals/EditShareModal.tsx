import useUpdateShare from "@/features/file-storage/api/shares/useUpdateShare";
import { useEffect, useState } from "react";
import "../styles.css";
import type {
  Share,
  UpdateShareInput,
} from "@/features/file-storage/api/shares/types";
import {
  Alert,
  Button,
  Col,
  DateTimeInput,
  Input,
  Modal,
  Switch,
  TextArea,
} from "@kosmeo-ui/react";

interface EditShareModalProps {
  bucketName: string;
  share: Share | null;
  show: boolean;
  onClose: () => void;
}

const EditShareModal = ({
  bucketName,
  share,
  show,
  onClose,
}: EditShareModalProps) => {
  const { mutate: updateShare, isPending } = useUpdateShare(bucketName);

  // Three-state model for password: leave (untouched), set (new), clear (null).
  const [passwordMode, setPasswordMode] = useState<"leave" | "set" | "clear">(
    "leave"
  );
  const [password, setPassword] = useState("");
  const [hasExpiry, setHasExpiry] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [hasMaxDownloads, setHasMaxDownloads] = useState(false);
  const [maxDownloads, setMaxDownloads] = useState(1);
  const [urlFilename, setUrlFilename] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!show || !share) return;
    setPasswordMode("leave");
    setPassword("");
    setHasExpiry(!!share.expiresAt);
    setExpiresAt(share.expiresAt ?? null);
    setHasMaxDownloads(share.maxDownloads !== null);
    setMaxDownloads(share.maxDownloads ?? 1);
    setUrlFilename(share.urlFilename ?? "");
    setNote(share.note ?? "");
  }, [show, share]);

  if (!share) return null;

  const handleSubmit = () => {
    const data: UpdateShareInput = {};

    if (passwordMode !== "leave") data.password = password || null;

    if (hasExpiry && expiresAt) {
      if (expiresAt !== share.expiresAt) data.expiresAt = expiresAt;
    } else if (!hasExpiry && share.expiresAt) {
      data.expiresAt = null;
    }

    if (hasMaxDownloads) {
      if (maxDownloads !== share.maxDownloads) data.maxDownloads = maxDownloads;
    } else if (share.maxDownloads !== null) {
      data.maxDownloads = null;
    }

    const trimmedFilename = urlFilename.trim();
    if (trimmedFilename !== (share.urlFilename ?? "")) {
      data.urlFilename = trimmedFilename || null;
    }
    if (note !== (share.note ?? "")) {
      data.note = note || null;
    }

    if (Object.keys(data).length === 0) {
      onClose();
      return;
    }

    updateShare(
      { id: share.id, data },
      {
        onSuccess: () => onClose(),
      }
    );
  };

  return (
    <Modal
      show={show}
      onClose={onClose}
      title="Edit Share"
      footerButtons={[
        <Button
          key="save"
          onClick={handleSubmit}
          isLoading={isPending}
          disabled={isPending}
        >
          Save
        </Button>,
        <Button
          key="cancel"
          variant="secondary"
          onClick={onClose}
          disabled={isPending}
        >
          Cancel
        </Button>,
      ]}
    >
      <Col>
        {share.url !== null && (
          <Input label="Share URL" value={share.url} disabled />
        )}

        {share.status === "expired" && (
          <Alert variant="warning">
            This share is currently expired. Setting a future expiration date
            below will reactivate it.
          </Alert>
        )}
        {share.status === "exhausted" && (
          <Alert variant="warning">
            This share has hit its download cap ({share.downloadCount} /{" "}
            {share.maxDownloads}). Raising the cap below will reactivate it.
          </Alert>
        )}

        <Switch
          checked={hasExpiry}
          onChange={(e) => setHasExpiry(e.target.checked)}
          label="Set expiration date"
        />
        {hasExpiry ? (
          <DateTimeInput
            label="Expires at"
            value={expiresAt}
            onChange={(iso) => setExpiresAt(iso)}
          />
        ) : (
          <p className="t-share-hint">
            Every share expires. Without a date, this one expires after the
            maximum allowed lifetime (365 days unless the server sets another),
            counted from when you save.
          </p>
        )}

        <Switch
          checked={hasMaxDownloads}
          onChange={(e) => setHasMaxDownloads(e.target.checked)}
          label="Cap downloads"
        />
        {hasMaxDownloads && (
          <Input
            label={`Max downloads (already used ${share.downloadCount})`}
            type="number"
            min={1}
            value={String(maxDownloads)}
            onChange={(e) => setMaxDownloads(Number(e.target.value) || 1)}
          />
        )}

        <Input
          label="URL filename (cosmetic)"
          value={urlFilename}
          onChange={(e) => setUrlFilename(e.target.value)}
          placeholder="report.pdf"
        />

        <TextArea
          label="Note (admin only)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
        />

        <div className="t-share-password-edit">
          <label className="t-share-password-edit-label">
            Password ({share.hasPassword ? "currently set" : "none"})
          </label>
          <Switch
            checked={passwordMode !== "leave"}
            onChange={(e) =>
              setPasswordMode(e.target.checked ? "set" : "leave")
            }
            label="Change password"
          />
          {passwordMode !== "leave" && (
            <>
              <Input
                label="New password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPasswordMode(e.target.value ? "set" : "clear");
                }}
                placeholder="Leave blank to remove password"
              />
              {!password && (
                <Alert variant="warning">
                  Saving with a blank password removes it.
                </Alert>
              )}
            </>
          )}
        </div>
      </Col>
    </Modal>
  );
};

export default EditShareModal;
