import useUpdateBucket from "@/features/file-storage/api/buckets/useUpdateBucket";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import type {
  Bucket,
  CorsConfig,
} from "@/features/file-storage/api/buckets/types";
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  Row,
  SectionHeader,
  TextArea,
} from "@kosmeo-ui/react";

interface CorsTabProps {
  bucket: Bucket;
  canWrite: boolean;
}

interface FormState {
  allowedOrigins: string;
  allowedMethods: string;
  allowedHeaders: string;
  exposedHeaders: string;
  maxAgeSeconds: number;
  allowCredentials: boolean;
}

const defaultState: FormState = {
  allowedOrigins: "",
  allowedMethods: "GET, HEAD",
  allowedHeaders: "Content-Type, Authorization",
  exposedHeaders: "",
  maxAgeSeconds: 600,
  allowCredentials: false,
};

const splitCsv = (s: string): string[] =>
  s
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

const fromConfig = (cfg: CorsConfig | null): FormState => {
  if (!cfg) return defaultState;
  return {
    allowedOrigins: cfg.allowedOrigins.join(", "),
    allowedMethods: cfg.allowedMethods.join(", "),
    allowedHeaders: cfg.allowedHeaders.join(", "),
    exposedHeaders: (cfg.exposedHeaders ?? []).join(", "),
    maxAgeSeconds: cfg.maxAgeSeconds,
    allowCredentials: cfg.allowCredentials,
  };
};

const toConfig = (f: FormState): CorsConfig => ({
  allowedOrigins: splitCsv(f.allowedOrigins),
  allowedMethods: splitCsv(f.allowedMethods),
  allowedHeaders: splitCsv(f.allowedHeaders),
  exposedHeaders: splitCsv(f.exposedHeaders),
  maxAgeSeconds: f.maxAgeSeconds,
  allowCredentials: f.allowCredentials,
});

const CorsTab = ({ bucket, canWrite }: CorsTabProps) => {
  const { hasPermission } = useAuth();
  const { mutate: updateBucket, isPending } = useUpdateBucket();
  const [form, setForm] = useState<FormState>(fromConfig(bucket.corsConfig));

  useEffect(() => {
    setForm(fromConfig(bucket.corsConfig));
  }, [bucket.corsConfig]);

  const effectivelyWrite =
    canWrite && hasPermission("file-service.buckets.write");

  const parsedOrigins = useMemo(
    () => splitCsv(form.allowedOrigins),
    [form.allowedOrigins]
  );
  const parsedMethods = useMemo(
    () => splitCsv(form.allowedMethods),
    [form.allowedMethods]
  );
  const hasOrigins = parsedOrigins.length > 0;
  const hasMethods = parsedMethods.length > 0;
  const canSave = hasOrigins && hasMethods;

  const save = () => {
    if (!canSave) return;
    updateBucket({
      bucketName: bucket.name,
      data: { corsConfig: toConfig(form) },
    });
  };

  const clear = () => {
    updateBucket({ bucketName: bucket.name, data: { corsConfig: null } });
  };

  return (
    <Card>
      <SectionHeader
        title="CORS"
        actions={
          <>
            {effectivelyWrite && (
              <Button
                size="sm"
                onClick={save}
                isLoading={isPending}
                disabled={!canSave}
              >
                Save CORS config
              </Button>
            )}
            {bucket.corsConfig && effectivelyWrite && (
              <Button
                size="sm"
                variant="danger"
                onClick={clear}
                isLoading={isPending}
              >
                Clear
              </Button>
            )}
          </>
        }
      />

      <Col size="md">
        {!bucket.corsConfig && (
          <Alert variant="primary">
            No per-bucket CORS config. Requests fall through to the service-wide
            default.
          </Alert>
        )}
        {!hasOrigins && (
          <Alert variant="warning">
            At least one allowed origin is required.
          </Alert>
        )}
        {!hasMethods && (
          <Alert variant="warning">
            At least one allowed method is required.
          </Alert>
        )}
        <TextArea
          label="Allowed origins"
          value={form.allowedOrigins}
          onChange={(e) => setForm({ ...form, allowedOrigins: e.target.value })}
          placeholder="Comma-separated. Use * to allow any origin."
          disabled={!effectivelyWrite}
        />
        <Row>
          <Input
            label="Allowed methods"
            value={form.allowedMethods}
            onChange={(e) =>
              setForm({ ...form, allowedMethods: e.target.value })
            }
            placeholder="GET, HEAD, PUT, POST, DELETE, PATCH"
            disabled={!effectivelyWrite}
          />
          <Input
            label="Max age (seconds)"
            type="number"
            value={String(form.maxAgeSeconds)}
            onChange={(e) =>
              setForm({
                ...form,
                maxAgeSeconds: Number.parseInt(e.target.value, 10) || 0,
              })
            }
            disabled={!effectivelyWrite}
          />
        </Row>
        <Input
          label="Allowed headers"
          value={form.allowedHeaders}
          onChange={(e) => setForm({ ...form, allowedHeaders: e.target.value })}
          placeholder="Content-Type, Authorization, X-Metadata, X-Tags"
          disabled={!effectivelyWrite}
        />
        <Input
          label="Exposed headers"
          value={form.exposedHeaders}
          onChange={(e) => setForm({ ...form, exposedHeaders: e.target.value })}
          placeholder="ETag"
          disabled={!effectivelyWrite}
        />
      </Col>
    </Card>
  );
};

export default CorsTab;
