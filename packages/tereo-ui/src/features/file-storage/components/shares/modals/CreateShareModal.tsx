import useInfiniteObjectVersions from "@/features/file-storage/api/objects/useInfiniteObjectVersions";
import useCreateShare from "@/features/file-storage/api/shares/useCreateShare";
import useBucket from "@/features/file-storage/api/buckets/useBucket";
import { faCopy } from "@fortawesome/free-solid-svg-icons";
import { useEffect, useMemo, useState } from "react";
import { formatDateTime } from "@/utils/formatDate";
import { toast } from "react-toastify";
import "../styles.css";
import type {
  CreateShareInput,
  RevealedShare,
  ShareArchiveFormat,
  ShareKind,
} from "@/features/file-storage/api/shares/types";
import {
  Alert,
  Button,
  Col,
  DateTimeInput,
  IconButton,
  Input,
  Modal,
  Select,
  Switch,
  TextArea,
} from "@kosmeo-ui/react";

/**
 * How the cosmetic suffix after `/shared/:token` is derived. Recipients see
 * this in the URL and — in the absence of `Content-Disposition` on the final
 * redirect — browsers use it as the default "Save As" filename.
 */
type UrlFilenameMode =
  "object-id" | "key-with-prefix" | "key-basename" | "folder-name" | "custom";

export interface CreateShareModalProps {
  bucketName: string;
  show: boolean;
  onClose: () => void;
  onCreated?: (share: RevealedShare) => void;
  /** When provided, the modal opens pre-populated for an OBJECT share of
   * this object. Otherwise the user can toggle kind and pick target fields. */
  seedObject?: { id: string; objectKey: string } | null;
  /** When provided, seeds an ARCHIVE share for this prefix. */
  seedPrefix?: string | null;
  /** When provided, seeds an ARCHIVE share with these keys. */
  seedKeys?: string[] | null;
}

const CreateShareModal = ({
  bucketName,
  show,
  onClose,
  onCreated,
  seedObject,
  seedPrefix,
  seedKeys,
}: CreateShareModalProps) => {
  const { mutate: createShare, isPending } = useCreateShare(bucketName);
  const { data: bucket } = useBucket(bucketName);

  const initialKind: ShareKind = useMemo(() => {
    if (seedObject) return "OBJECT";
    if (seedPrefix || seedKeys) return "ARCHIVE";
    return "OBJECT";
  }, [seedObject, seedPrefix, seedKeys]);

  const [kind, setKind] = useState<ShareKind>(initialKind);
  const [objectId, setObjectId] = useState(seedObject?.id ?? "");
  const [pinVersion, setPinVersion] = useState(false);
  const [versionId, setVersionId] = useState("");
  const [prefix, setPrefix] = useState(seedPrefix ?? "");
  const [keysText, setKeysText] = useState((seedKeys ?? []).join("\n"));
  const [format, setFormat] = useState<ShareArchiveFormat>("zip");
  const [password, setPassword] = useState("");
  const [hasExpiry, setHasExpiry] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  );
  const [hasMaxDownloads, setHasMaxDownloads] = useState(false);
  const [maxDownloads, setMaxDownloads] = useState<number>(1);
  // URL-filename mode + the free-text fallback for "custom". Defaults:
  // - OBJECT        → `key-basename` (matches server's derived default)
  // - ARCHIVE prefix → `folder-name`
  // - ARCHIVE keys   → `custom` (no folder concept when sharing loose files)
  const initialUrlFilenameMode: UrlFilenameMode =
    initialKind === "OBJECT"
      ? "key-basename"
      : seedPrefix
        ? "folder-name"
        : "custom";
  const [urlFilenameMode, setUrlFilenameMode] = useState<UrlFilenameMode>(
    initialUrlFilenameMode
  );
  const [customUrlFilename, setCustomUrlFilename] = useState("");
  const [note, setNote] = useState("");
  const [createdShare, setCreatedShare] = useState<RevealedShare | null>(null);

  useEffect(() => {
    if (!show) return;
    setKind(initialKind);
    setObjectId(seedObject?.id ?? "");
    setPinVersion(false);
    setVersionId("");
    setPrefix(seedPrefix ?? "");
    setKeysText((seedKeys ?? []).join("\n"));
    setPassword("");
    setHasExpiry(false);
    setHasMaxDownloads(false);
    setMaxDownloads(1);
    setUrlFilenameMode(initialUrlFilenameMode);
    setCustomUrlFilename("");
    setNote("");
    setCreatedShare(null);
  }, [show, initialKind, seedObject, seedPrefix, seedKeys]);

  // Only fetch versions when the user actually opts to pin one — avoids
  // an extra round-trip for the common "share current" case.
  const versionsEnabled =
    show &&
    kind === "OBJECT" &&
    pinVersion &&
    !!objectId &&
    !!bucket?.versioningEnabled;
  const { data: versions } = useInfiniteObjectVersions(bucketName, objectId, {
    enabled: versionsEnabled,
  });

  /**
   * Resolve the URL-filename mode down to the string we send as `urlFilename`.
   * Returns undefined when the chosen mode can't be computed (no object key
   * available for key-based modes, or empty custom value) — the server then
   * falls back to its own default.
   */
  const effectiveUrlFilename = useMemo((): string | undefined => {
    if (kind === "OBJECT") {
      const key = seedObject?.objectKey;
      switch (urlFilenameMode) {
        case "object-id":
          return seedObject?.id ?? (objectId || undefined);
        case "key-with-prefix":
          return key || undefined;
        case "key-basename":
          return key ? (key.split("/").pop() ?? key) : undefined;
        case "custom":
          return customUrlFilename.trim() || undefined;
        default:
          return undefined;
      }
    }
    // ARCHIVE
    switch (urlFilenameMode) {
      case "folder-name": {
        const p = seedPrefix ?? prefix;
        if (!p) return undefined;
        const trimmed = p.replace(/\/+$/, "");
        const last = trimmed.split("/").filter(Boolean).pop();
        return last ? `${last}.${format}` : undefined;
      }
      case "custom":
        return customUrlFilename.trim() || undefined;
      default:
        return customUrlFilename.trim() || undefined;
    }
  }, [
    kind,
    urlFilenameMode,
    seedObject,
    objectId,
    seedPrefix,
    prefix,
    format,
    customUrlFilename,
  ]);

  const keyBasedModesDisabled = kind === "OBJECT" && !seedObject?.objectKey;

  const handleSubmit = () => {
    const common = {
      password: password || undefined,
      expiresAt: hasExpiry && expiresAt ? expiresAt : undefined,
      maxDownloads: hasMaxDownloads ? maxDownloads : undefined,
      urlFilename: effectiveUrlFilename,
      note: note || undefined,
    };

    let input: CreateShareInput;
    if (kind === "OBJECT") {
      if (!objectId) {
        toast.error("Object id is required");
        return;
      }
      if (pinVersion && !versionId) {
        toast.error("Pick a version to pin to");
        return;
      }
      input = {
        kind: "OBJECT",
        objectId,
        versionId: pinVersion && versionId ? versionId : undefined,
        ...common,
      };
    } else {
      const keys = keysText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (prefix && keys.length > 0) {
        toast.error("Provide a prefix OR keys, not both");
        return;
      }
      if (!prefix && keys.length === 0) {
        toast.error("Provide a prefix or at least one key");
        return;
      }
      input = {
        kind: "ARCHIVE",
        prefix: prefix || undefined,
        keys: keys.length > 0 ? keys : undefined,
        format,
        ...common,
      };
    }

    createShare(input, {
      onSuccess: (share) => {
        setCreatedShare(share);
        onCreated?.(share);
      },
    });
  };

  const copyUrl = async () => {
    if (!createdShare) return;
    try {
      await navigator.clipboard.writeText(createdShare.url);
      toast.success("Link copied to clipboard");
    } catch {
      toast.error("Clipboard blocked — copy manually from the URL field");
    }
  };

  return (
    <Modal
      show={show}
      onClose={onClose}
      title={createdShare ? "Share Link Ready" : "Create Share Link"}
      footerButtons={
        createdShare
          ? [
              <Button key="done" onClick={onClose}>
                Done
              </Button>,
            ]
          : [
              <Button
                key="create"
                onClick={handleSubmit}
                isLoading={isPending}
                disabled={isPending}
              >
                Create Share
              </Button>,
              <Button
                key="cancel"
                variant="secondary"
                onClick={onClose}
                disabled={isPending}
              >
                Cancel
              </Button>,
            ]
      }
    >
      {createdShare ? (
        <Col>
          <div className="t-share-url-row">
            <Input label="Share URL" value={createdShare.url} disabled />
            <IconButton
              icon={faCopy}
              onClick={copyUrl}
              variant="light"
              size="sm"
              aria-label="Copy link"
            />
          </div>
          {createdShare.hasPassword && (
            <Alert variant="warning">
              This share is password-protected. Send the password separately.
            </Alert>
          )}
        </Col>
      ) : (
        <Col>
          {!seedObject && !seedPrefix && !seedKeys && (
            <Select
              label="Kind"
              value={kind}
              onChange={(v) => setKind(v as ShareKind)}
              options={[
                { value: "OBJECT", label: "Single object" },
                { value: "ARCHIVE", label: "Folder or multiple files" },
              ]}
            />
          )}

          {kind === "OBJECT" && (
            <Input
              label="Object ID"
              value={objectId}
              onChange={(e) => setObjectId(e.target.value)}
              placeholder="UUID of the object to share"
              disabled={Boolean(seedObject)}
            />
          )}

          {kind === "ARCHIVE" && (
            <>
              {/* Selection fields render as read-only when seeded from a row
                  (folder share or multi-select share) — the user picked the
                  selection by clicking on it, so changing it here would be
                  both surprising and an easy way to produce invalid
                  prefix+keys combinations. Free-entry mode (no seed, which
                  currently has no entry point) keeps both editable. */}
              {!seedKeys && (
                <Input
                  label="Folder"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder="e.g. reports/2026/"
                  disabled={Boolean(seedPrefix)}
                />
              )}
              {!seedPrefix && (
                <TextArea
                  label="Keys (one per line — leave empty when using prefix)"
                  value={keysText}
                  onChange={(e) => setKeysText(e.target.value)}
                  placeholder="reports/q1.pdf&#10;reports/q2.pdf"
                  rows={3}
                  disabled={Boolean(seedKeys)}
                />
              )}
              <Select
                label="Format"
                value={format}
                onChange={(v) => setFormat(v as ShareArchiveFormat)}
                options={[
                  { value: "zip", label: "ZIP" },
                  { value: "tar", label: "TAR" },
                ]}
              />
            </>
          )}

          <Input
            label="Password (optional)"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Leave blank for no password"
          />

          {kind === "OBJECT" && bucket?.versioningEnabled && (
            <>
              <Switch
                checked={pinVersion}
                onChange={(e) => {
                  setPinVersion(e.target.checked);
                  if (!e.target.checked) setVersionId("");
                }}
                label="Pin to a specific version (immutable share)"
              />
              {pinVersion && (
                <Select
                  label="Version"
                  value={versionId}
                  onChange={(v) => setVersionId(v as string)}
                  options={[
                    { value: "", label: "— pick a version —" },
                    // A delete marker has no content to download.
                    ...(versions ?? [])
                      .filter((v) => !v.isDeleteMarker)
                      .map((v) => ({
                        value: v.versionId,
                        label: `${v.isCurrent ? "★ current — " : ""}${formatDateTime(v.createdAt)}`,
                      })),
                  ]}
                />
              )}
            </>
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
              maximum allowed lifetime (365 days unless the server sets
              another).
            </p>
          )}

          <Switch
            checked={hasMaxDownloads}
            onChange={(e) => setHasMaxDownloads(e.target.checked)}
            label="Cap downloads"
          />
          {hasMaxDownloads && (
            <Input
              label="Max downloads"
              type="number"
              min={1}
              value={String(maxDownloads)}
              onChange={(e) => setMaxDownloads(Number(e.target.value) || 1)}
            />
          )}

          {kind === "OBJECT" ? (
            <>
              <Select
                label="URL filename"
                value={urlFilenameMode}
                onChange={(v) => setUrlFilenameMode(v as UrlFilenameMode)}
                options={[
                  { value: "object-id", label: "Object ID" },
                  {
                    value: "key-with-prefix",
                    label: "Object key (with prefix)",
                  },
                  {
                    value: "key-basename",
                    label: "Object key (without prefix)",
                  },
                  { value: "custom", label: "Custom" },
                ]}
              />
              {keyBasedModesDisabled &&
                (urlFilenameMode === "key-with-prefix" ||
                  urlFilenameMode === "key-basename") && (
                  <div className="v-help-text">
                    Object key isn't available — the server will fall back to
                    its own default.
                  </div>
                )}
              {urlFilenameMode === "custom" && (
                <Input
                  label="Custom filename"
                  value={customUrlFilename}
                  onChange={(e) => setCustomUrlFilename(e.target.value)}
                  placeholder="report.pdf"
                />
              )}
              <div className="v-help-text">
                Preview:{" "}
                {effectiveUrlFilename ? (
                  <code>
                    /shared/…/{encodeURIComponent(effectiveUrlFilename)}
                  </code>
                ) : (
                  <em>enter a filename above</em>
                )}
              </div>
            </>
          ) : seedPrefix || prefix ? (
            <>
              <Select
                label="URL filename"
                value={urlFilenameMode}
                onChange={(v) => setUrlFilenameMode(v as UrlFilenameMode)}
                options={[
                  { value: "folder-name", label: "Folder name" },
                  { value: "custom", label: "Custom" },
                ]}
              />
              {urlFilenameMode === "custom" && (
                <Input
                  label="Custom filename"
                  value={customUrlFilename}
                  onChange={(e) => setCustomUrlFilename(e.target.value)}
                  placeholder="bundle.zip"
                />
              )}
              <div className="v-help-text">
                Preview:{" "}
                {effectiveUrlFilename ? (
                  <code>
                    /shared/…/{encodeURIComponent(effectiveUrlFilename)}
                  </code>
                ) : (
                  <em>enter a filename above</em>
                )}
              </div>
            </>
          ) : (
            <Input
              label="URL filename (optional)"
              value={customUrlFilename}
              onChange={(e) => setCustomUrlFilename(e.target.value)}
              placeholder="bundle.zip (appears in the share URL)"
            />
          )}

          <TextArea
            label="Note (admin only)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
          />
        </Col>
      )}
    </Modal>
  );
};

export default CreateShareModal;
