import useObjectByKey from "@/features/file-storage/api/objects/useObjectByKey";
import { faEdit } from "@fortawesome/free-solid-svg-icons";
import { useEffect, useState } from "react";
import "../styles.css";
import useUpdateObject, {
  type UpdateObjectInput,
} from "@/features/file-storage/api/objects/useUpdateObject";
import {
  MAX_TAG_LENGTH,
  MAX_TAGS,
  tagsError,
} from "@/features/file-storage/api/objects/uploadHeaders";
import {
  Alert,
  Button,
  Col,
  DateTimeInput,
  IconButton,
  Input,
  Modal,
  Switch,
  TextArea,
} from "@kosmeo-ui/react";

interface EditObjectButtonProps {
  bucketName: string;
  object: {
    id: string;
    key: string;
  };
  /** Versioning-on buckets show the "create new version" toggle. */
  versioningEnabled: boolean;
  onUpdate: () => void;
}

const EditObjectButton = ({
  bucketName,
  object,
  versioningEnabled,
  onUpdate,
}: EditObjectButtonProps) => {
  const [show, setShow] = useState(false);
  const { data: full } = useObjectByKey(bucketName, object.key, {
    enabled: show,
  });
  const { mutate: updateObject, isPending } = useUpdateObject(bucketName);

  const [objectKey, setObjectKey] = useState(object.key);
  const [contentType, setContentType] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [metadataText, setMetadataText] = useState("");
  const [hasDeleteAfter, setHasDeleteAfter] = useState(false);
  const [deleteAfter, setDeleteAfter] = useState<string | null>(null);
  const [createNewVersion, setCreateNewVersion] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [tagsValidation, setTagsValidation] = useState<string | null>(null);

  useEffect(() => {
    if (!show) return;
    setObjectKey(object.key);
    setMetadataError(null);
    setTagsValidation(null);
    setCreateNewVersion(false);
    if (full) {
      setContentType(full.contentType);
      setTagsText((full.tags ?? []).join(", "));
      setMetadataText(
        full.metadata ? JSON.stringify(full.metadata, null, 2) : ""
      );
      setHasDeleteAfter(!!full.deleteAfter);
      setDeleteAfter(full.deleteAfter ?? null);
    } else {
      setContentType("");
      setTagsText("");
      setMetadataText("");
      setHasDeleteAfter(false);
      setDeleteAfter(null);
    }
  }, [show, object.key, full]);

  const handleSubmit = () => {
    const data: UpdateObjectInput = {};
    if (objectKey.trim() && objectKey !== object.key) {
      data.objectKey = objectKey.trim();
    }
    if (full && contentType !== full.contentType) {
      data.contentType = contentType;
    }
    // Compared as text: re-splitting the loaded tags would split one that
    // holds a comma (set through the API) and rewrite it on every save.
    if (full && tagsText !== (full.tags ?? []).join(", ")) {
      const tags = tagsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const error = tagsError(tags);
      if (error) {
        setTagsValidation(error);
        return;
      }
      data.tags = tags;
    }
    setTagsValidation(null);
    if (metadataText.trim()) {
      try {
        const parsed = JSON.parse(metadataText) as Record<string, unknown>;
        const currentJson = full?.metadata ? JSON.stringify(full.metadata) : "";
        if (JSON.stringify(parsed) !== currentJson) {
          data.metadata = parsed;
        }
      } catch {
        setMetadataError("Metadata must be valid JSON");
        return;
      }
    } else if (full?.metadata && Object.keys(full.metadata).length > 0) {
      // Core's PATCH schema takes a record, not null — `{}` clears it.
      data.metadata = {};
    }
    if (hasDeleteAfter) {
      const iso = deleteAfter ?? null;
      if (iso !== (full?.deleteAfter ?? null)) data.deleteAfter = iso;
    } else if (full?.deleteAfter) {
      data.deleteAfter = null;
    }
    // `createNewVersion` is a modifier, not an edit: core requires at least
    // one editable field alongside it.
    if (Object.keys(data).length === 0) {
      setShow(false);
      return;
    }
    if (versioningEnabled && createNewVersion) data.createNewVersion = true;

    setMetadataError(null);
    updateObject(
      { id: object.id, previousKey: object.key, data },
      {
        onSuccess: () => {
          setShow(false);
          onUpdate();
        },
      }
    );
  };

  return (
    <>
      <IconButton
        icon={faEdit}
        title="Edit"
        onClick={(e) => {
          e.stopPropagation();
          setShow(true);
        }}
        variant="primary"
        size="sm"
      />

      <Modal
        show={show}
        onClose={() => setShow(false)}
        title="Edit Object"
        footerButtons={[
          <Button
            key="save"
            onClick={handleSubmit}
            isLoading={isPending}
            disabled={isPending || !full}
          >
            Save
          </Button>,
          <Button
            key="cancel"
            variant="secondary"
            onClick={() => setShow(false)}
            disabled={isPending}
          >
            Cancel
          </Button>,
        ]}
      >
        <Col>
          <Input
            label="Object key"
            value={objectKey}
            onChange={(e) => setObjectKey(e.target.value)}
            placeholder="path/to/file.ext"
          />
          <Input
            label="Content type"
            value={contentType}
            onChange={(e) => setContentType(e.target.value)}
            placeholder="application/octet-stream"
          />
          <Input
            label="Tags (comma-separated)"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="invoice, q1, customer-acme"
            error={tagsValidation}
            helperText={`Up to ${MAX_TAGS} tags of ${MAX_TAG_LENGTH} characters; a tag cannot contain a comma`}
          />
          <TextArea
            label="Metadata (JSON)"
            value={metadataText}
            onChange={(e) => setMetadataText(e.target.value)}
            placeholder='{"author": "alice"}'
            rows={4}
          />
          {metadataError && <Alert variant="danger">{metadataError}</Alert>}
          <Switch
            checked={hasDeleteAfter}
            onChange={(e) => setHasDeleteAfter(e.target.checked)}
            label="Set per-object expiration (overrides bucket lifecycle policy)"
          />
          {hasDeleteAfter && (
            <DateTimeInput
              label="Delete after"
              value={deleteAfter}
              onChange={(iso) => setDeleteAfter(iso)}
            />
          )}
          {versioningEnabled && (
            <Switch
              checked={createNewVersion}
              onChange={(e) => setCreateNewVersion(e.target.checked)}
              label="Branch a new version for this edit"
            />
          )}
        </Col>
      </Modal>
    </>
  );
};

export default EditObjectButton;
