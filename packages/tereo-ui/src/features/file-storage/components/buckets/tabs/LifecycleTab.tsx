import useDeleteLifecyclePolicy from "@/features/file-storage/api/buckets/useDeleteLifecyclePolicy";
import useUpsertLifecyclePolicy from "@/features/file-storage/api/buckets/useUpsertLifecyclePolicy";
import type { UpsertLifecyclePolicyInput } from "@/features/file-storage/api/buckets/types";
import useLifecyclePolicy from "@/features/file-storage/api/buckets/useLifecyclePolicy";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  Alert,
  Button,
  Card,
  Col,
  ConfirmationModal,
  Input,
  Row,
  SectionHeader,
  Spinner,
  Switch,
} from "@kosmeo-ui/react";

interface LifecycleTabProps {
  bucketName: string;
  canWrite: boolean;
  canDelete: boolean;
}

const toInputValue = (n: number | null | undefined) =>
  n === null || n === undefined ? "" : String(n);

const toOptionalInt = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

const LifecycleTab = ({
  bucketName,
  canWrite,
  canDelete,
}: LifecycleTabProps) => {
  const { hasPermission } = useAuth();
  const { data: policy, isLoading } = useLifecyclePolicy(bucketName);
  const { mutate: upsert, isPending: isSaving } =
    useUpsertLifecyclePolicy(bucketName);
  const { mutate: remove, isPending: isRemoving } =
    useDeleteLifecyclePolicy(bucketName);

  const [form, setForm] = useState<UpsertLifecyclePolicyInput>({
    expireObjectsAfterDays: null,
    expireVersionsAfterDays: null,
    purgeSoftDeletedAfterDays: null,
    enabled: true,
  });
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  useEffect(() => {
    if (policy) {
      setForm({
        expireObjectsAfterDays: policy.expireObjectsAfterDays,
        expireVersionsAfterDays: policy.expireVersionsAfterDays,
        purgeSoftDeletedAfterDays: policy.purgeSoftDeletedAfterDays,
        enabled: policy.enabled,
      });
    }
  }, [policy]);

  if (!hasPermission("file-service.buckets.read")) return null;
  if (isLoading) return <Spinner />;

  const effectivelyWrite =
    canWrite && hasPermission("file-service.buckets.write");

  // Refuse to write a no-op policy. toOptionalInt already rejects
  // non-positive / empty inputs, so a null value here means "no rule".
  const hasAnyRule =
    (form.expireObjectsAfterDays ?? null) !== null ||
    (form.expireVersionsAfterDays ?? null) !== null ||
    (form.purgeSoftDeletedAfterDays ?? null) !== null;

  return (
    <Card>
      <SectionHeader
        title="Lifecycle"
        actions={
          <>
            <Switch
              size="sm"
              checked={form.enabled ?? false}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              disabled={!effectivelyWrite || !hasAnyRule}
              label="Policy enabled"
            />
            {effectivelyWrite && (
              <Button
                size="sm"
                onClick={() => upsert(form)}
                isLoading={isSaving}
                disabled={!hasAnyRule}
              >
                Save policy
              </Button>
            )}
            {policy &&
              canDelete &&
              hasPermission("file-service.buckets.delete") && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setShowRemoveConfirm(true)}
                  isLoading={isRemoving}
                >
                  Remove policy
                </Button>
              )}
          </>
        }
      />

      <Col size="md">
        {!policy && (
          <Alert variant="primary">
            No lifecycle policy is configured for this bucket. Add rules below
            to automatically expire old objects and versions.
          </Alert>
        )}
        <Row>
          <Input
            label="Expire objects after (days)"
            type="number"
            value={toInputValue(form.expireObjectsAfterDays)}
            onChange={(e) =>
              setForm({
                ...form,
                expireObjectsAfterDays: toOptionalInt(e.target.value),
              })
            }
            placeholder="Leave empty to keep forever"
            disabled={!effectivelyWrite}
          />
          <Input
            label="Expire non-current versions after (days)"
            type="number"
            value={toInputValue(form.expireVersionsAfterDays)}
            onChange={(e) =>
              setForm({
                ...form,
                expireVersionsAfterDays: toOptionalInt(e.target.value),
              })
            }
            placeholder="Leave empty to keep forever"
            disabled={!effectivelyWrite}
          />
          <Input
            label="Purge soft-deleted objects after (days)"
            type="number"
            value={toInputValue(form.purgeSoftDeletedAfterDays)}
            onChange={(e) =>
              setForm({
                ...form,
                purgeSoftDeletedAfterDays: toOptionalInt(e.target.value),
              })
            }
            placeholder="Leave empty to never hard-delete"
            disabled={!effectivelyWrite}
          />
        </Row>
      </Col>
      <ConfirmationModal
        show={showRemoveConfirm}
        handleHide={() => setShowRemoveConfirm(false)}
        handleConfirm={() =>
          remove(undefined, {
            onSuccess: () => setShowRemoveConfirm(false),
          })
        }
        title="Remove lifecycle policy"
        body={`Remove lifecycle policy from bucket "${bucketName}"? Objects will no longer expire automatically.`}
        confirmButtonText={isRemoving ? "Removing…" : "Remove policy"}
        isLoading={isRemoving}
      />
    </Card>
  );
};

export default LifecycleTab;
