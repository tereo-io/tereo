import { isDeclaredBucket } from "@/features/file-storage/api/buckets/bucketOwnership";
import useUpdateBucket from "@/features/file-storage/api/buckets/useUpdateBucket";
import { faEdit } from "@fortawesome/free-solid-svg-icons";
import { useState, useEffect } from "react";
import "../styles.css";
import type {
  Bucket,
  RateLimitConfig,
  UpdateBucketInput,
} from "@/features/file-storage/api/buckets/types";
import {
  Button,
  Col,
  IconButton,
  Input,
  Modal,
  Row,
  Select,
  Switch,
  TextArea,
} from "@kosmeo-ui/react";

interface EditBucketButtonProps {
  bucket: Bucket;
  onUpdate: () => void;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  tokensPerSecond: 100,
  maxTokens: 200,
  requestCost: 1,
};

const EditBucketButton = ({ bucket, onUpdate }: EditBucketButtonProps) => {
  const [show, setShow] = useState(false);
  const { mutate: updateBucket, isPending } = useUpdateBucket();
  const [formData, setFormData] = useState<UpdateBucketInput>({
    description: bucket.description || "",
    policy: bucket.policy,
    versioningEnabled: bucket.versioningEnabled,
    autoThumbnails: bucket.autoThumbnails,
  });
  const [hasRateLimit, setHasRateLimit] = useState(!!bucket.rateLimitConfig);
  const [rateLimit, setRateLimit] = useState<RateLimitConfig>(
    bucket.rateLimitConfig ?? DEFAULT_RATE_LIMIT
  );

  useEffect(() => {
    if (show) {
      setFormData({
        description: bucket.description || "",
        policy: bucket.policy,
        versioningEnabled: bucket.versioningEnabled,
        autoThumbnails: bucket.autoThumbnails,
      });
      setHasRateLimit(!!bucket.rateLimitConfig);
      setRateLimit(bucket.rateLimitConfig ?? DEFAULT_RATE_LIMIT);
    }
  }, [show, bucket]);

  const handleSubmit = () => {
    // Core refuses any description sent for a declared bucket unless it
    // equals the stored one, and an absent description is stored as null.
    const { description, ...rest } = formData;
    const data: UpdateBucketInput = {
      ...rest,
      rateLimitConfig: hasRateLimit ? rateLimit : null,
    };
    if (description !== (bucket.description || "")) {
      data.description = description;
    }
    updateBucket(
      { bucketName: bucket.name, data },
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
        onClick={() => setShow(true)}
        variant="primary"
        size="sm"
      />

      <Modal
        show={show}
        onClose={() => setShow(false)}
        title={`Edit Bucket: ${bucket.name}`}
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
            onClick={() => setShow(false)}
            disabled={isPending}
          >
            Cancel
          </Button>,
        ]}
      >
        <Col>
          <Input label="Bucket Name" value={bucket.name} disabled />
          <TextArea
            label={
              isDeclaredBucket(bucket)
                ? "Description (set by the declaring service)"
                : "Description"
            }
            value={formData.description || ""}
            onChange={(e) =>
              setFormData({ ...formData, description: e.target.value })
            }
            placeholder="Optional description"
            rows={3}
            disabled={isDeclaredBucket(bucket)}
          />
          <Select
            label="Policy"
            value={formData.policy}
            onChange={(value) =>
              setFormData({
                ...formData,
                policy: value as "public" | "private",
              })
            }
            options={[
              { value: "private", label: "Private" },
              { value: "public", label: "Public" },
            ]}
          />
          <Switch
            checked={formData.versioningEnabled ?? false}
            onChange={(e) =>
              setFormData({
                ...formData,
                versioningEnabled: e.target.checked,
              })
            }
            label="Versioning enabled"
          />
          <Switch
            checked={formData.autoThumbnails ?? false}
            onChange={(e) =>
              setFormData({ ...formData, autoThumbnails: e.target.checked })
            }
            label="Auto-generate image thumbnails"
          />
          <Switch
            checked={hasRateLimit}
            onChange={(e) => setHasRateLimit(e.target.checked)}
            label="Per-bucket rate limit"
          />
          {hasRateLimit && (
            <Row>
              <Input
                label="Tokens per second"
                type="number"
                min={1}
                value={String(rateLimit.tokensPerSecond)}
                onChange={(e) =>
                  setRateLimit({
                    ...rateLimit,
                    tokensPerSecond: Number(e.target.value) || 0,
                  })
                }
              />
              <Input
                label="Burst (max tokens)"
                type="number"
                min={1}
                value={String(rateLimit.maxTokens)}
                onChange={(e) =>
                  setRateLimit({
                    ...rateLimit,
                    maxTokens: Number(e.target.value) || 0,
                  })
                }
              />
              <Input
                label="Tokens per request"
                type="number"
                min={1}
                value={String(rateLimit.requestCost)}
                onChange={(e) =>
                  setRateLimit({
                    ...rateLimit,
                    requestCost: Number(e.target.value) || 1,
                  })
                }
              />
            </Row>
          )}
        </Col>
      </Modal>
    </>
  );
};

export default EditBucketButton;
