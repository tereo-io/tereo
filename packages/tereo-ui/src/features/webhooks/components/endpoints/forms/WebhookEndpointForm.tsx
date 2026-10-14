import { faPlus, faTrash } from "@fortawesome/free-solid-svg-icons";
import useEventTypes from "../../../api/event-types/useEventTypes";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import "../../styles.css";
import type {
  CreateWebhookEndpointInput,
  UpdateWebhookEndpointInput,
  WebhookEndpoint,
} from "../../../api/types";
import {
  Alert,
  Col,
  Form,
  FormError,
  IconButton,
  Input,
  MultiSelect,
  Select,
  TextArea,
} from "@kosmeo-ui/react";

interface WebhookEndpointFormProps {
  endpoint?: WebhookEndpoint;
  onSubmit: (
    data: CreateWebhookEndpointInput | UpdateWebhookEndpointInput
  ) => void;
  formId?: string;
}

const TEST_EVENT_TYPE = "webhook.test";
// Core returns every custom header value as this, and keeps the stored value
// when it is sent back unchanged.
const HEADER_VALUE_MASK = "********";

interface EventTypeOption {
  value: string;
  label: string;
}

interface HeaderRow {
  key: string;
  name: string;
  value: string;
}

// Mirrors core's customHeadersSchema (routes/v1/webhooks/webhooks/schemas.ts).
const MAX_HEADERS = 10;
const HEADER_NAME_RE = /^[a-zA-Z0-9-]+$/;
const RESERVED_HEADERS = [
  "content-type",
  "content-length",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "x-webhook-id",
  "x-webhook-event",
  "x-webhook-timestamp",
  "x-webhook-signature",
];
const isReservedHeader = (name: string) => {
  const lower = name.toLowerCase();
  return RESERVED_HEADERS.includes(lower) || lower.startsWith("proxy-");
};

const STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "PAUSED", label: "Paused" },
];

let rowSeq = 0;
const newRow = (name = "", value = ""): HeaderRow => ({
  key: `h${rowSeq++}`,
  name,
  value,
});

const headersToRecord = (rows: HeaderRow[]) =>
  Object.fromEntries(
    rows
      .filter((r) => r.name.trim())
      .map((r) => [r.name.trim(), r.value] as const)
  );

const validateHeaders = (
  rows: HeaderRow[],
  stored: Record<string, string>
): string | null => {
  const named = rows.filter((r) => r.name.trim());
  if (named.length > MAX_HEADERS)
    return `At most ${MAX_HEADERS} custom headers are allowed.`;
  const seen = new Set<string>();
  for (const { name, value } of named) {
    const n = name.trim();
    if (!HEADER_NAME_RE.test(n) || n.length > 100)
      return `Header "${n}" may contain only letters, digits and hyphens (max 100).`;
    if (isReservedHeader(n))
      return `"${n}" is set by core or the connection and cannot be overridden.`;
    if (seen.has(n.toLowerCase())) return `Header "${n}" is listed twice.`;
    if (value.length > 500)
      return `The value of "${n}" exceeds 500 characters.`;
    // Core keeps a stored value only under the exact name it was saved with.
    if (value === HEADER_VALUE_MASK && !Object.hasOwn(stored, n))
      return `Enter the value of "${n}": a renamed header does not keep its saved value.`;
    seen.add(n.toLowerCase());
  }
  return null;
};

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length &&
  [...a].sort().join("\n") === [...b].sort().join("\n");

export const WebhookEndpointForm = ({
  endpoint,
  onSubmit,
  formId,
}: WebhookEndpointFormProps) => {
  const { hasPermission } = useAuth();
  const canReadEventTypes = hasPermission("webhooks.event-types.read");
  const { data: eventTypes = [], isLoading: eventTypesLoading } =
    useEventTypes();

  // Only live, unreserved event types can be subscribed to — core rejects
  // retired ones and `webhook.test`, which only the test action sends.
  const options: EventTypeOption[] = useMemo(
    () =>
      eventTypes
        .filter((et) => !et.retiredAt && et.eventType !== TEST_EVENT_TYPE)
        .map((et) => ({ value: et.eventType, label: et.eventType })),
    [eventTypes]
  );

  const retired = endpoint?.retiredEventTypes ?? [];
  const liveSubscriptions = (endpoint?.eventTypes ?? []).filter(
    (et) => !retired.includes(et) && et !== TEST_EVENT_TYPE
  );

  const [url, setUrl] = useState(endpoint?.url ?? "");
  const [description, setDescription] = useState(endpoint?.description ?? "");
  const [selected, setSelected] = useState<string[]>(liveSubscriptions);
  const [status, setStatus] = useState(endpoint?.status ?? "ACTIVE");
  const [headers, setHeaders] = useState<HeaderRow[]>(() =>
    Object.entries(endpoint?.customHeaders ?? {}).map(([n, v]) => newRow(n, v))
  );
  const [error, setError] = useState<string | null>(null);

  const selectedOptions = selected.map(
    (s) => options.find((o) => o.value === s) ?? { value: s, label: s }
  );

  const statusOptions =
    endpoint?.status === "DISABLED"
      ? [
          { value: "DISABLED", label: "Disabled (after repeated failures)" },
          ...STATUS_OPTIONS,
        ]
      : STATUS_OPTIONS;

  const updateHeader = (key: string, patch: Partial<HeaderRow>) =>
    setHeaders((rows) =>
      rows.map((r) => (r.key === key ? { ...r, ...patch } : r))
    );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // An edit that keeps the subscriptions as they are doesn't resend them,
    // so an endpoint whose every subscription is retired can still be edited.
    if (
      selected.length === 0 &&
      (!endpoint || !sameSet(selected, liveSubscriptions))
    ) {
      setError("Select at least one event type.");
      return;
    }
    const headerError = validateHeaders(headers, endpoint?.customHeaders ?? {});
    if (headerError) {
      setError(headerError);
      return;
    }
    setError(null);

    const customHeaders = headersToRecord(headers);
    const hasHeaders = Object.keys(customHeaders).length > 0;

    if (!endpoint) {
      const input: CreateWebhookEndpointInput = {
        url: url.trim(),
        eventTypes: selected,
      };
      if (description.trim()) input.description = description.trim();
      if (hasHeaders) input.customHeaders = customHeaders;
      onSubmit(input);
      return;
    }

    const updates: UpdateWebhookEndpointInput = {};
    if (url.trim() !== endpoint.url) updates.url = url.trim();
    if (description.trim() !== (endpoint.description ?? ""))
      updates.description = description.trim() || null;
    if (!sameSet(selected, liveSubscriptions)) updates.eventTypes = selected;
    if (status !== endpoint.status && status !== "DISABLED")
      updates.status = status as "ACTIVE" | "PAUSED";
    if (
      JSON.stringify(customHeaders) !==
      JSON.stringify(endpoint.customHeaders ?? {})
    )
      updates.customHeaders = hasHeaders ? customHeaders : null;
    onSubmit(updates);
  };

  return (
    <Form onSubmit={handleSubmit} id={formId}>
      <Col>
        <Input
          label="URL"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          max={2048}
          placeholder="https://example.com/webhooks"
          helperText="Must be a public http(s) URL. A private address is refused when given as an IP, and at delivery when a name resolves to one."
        />
        <TextArea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          max={500}
          rows={2}
          placeholder="Optional"
        />
        {canReadEventTypes ? (
          <MultiSelect<EventTypeOption>
            label="Event Types"
            required
            options={options}
            value={selectedOptions}
            labelKey="label"
            onChange={(values) => setSelected(values.map((v) => v.value))}
            placeholder={
              eventTypesLoading
                ? "Loading event types..."
                : "Select event types"
            }
          />
        ) : (
          <Alert variant="warning">
            Selecting event types requires the webhooks.event-types.read
            permission.
          </Alert>
        )}
        {retired.length > 0 && (
          <Alert variant="warning">
            Subscribed to retired event types that will not fire again:{" "}
            {retired.join(", ")}. Changing the event types drops them.
          </Alert>
        )}
        {endpoint && (
          <Select
            label="Status"
            value={status}
            onChange={(v) => v && setStatus(v as typeof status)}
            options={statusOptions}
          />
        )}

        <Col size="sm">
          <strong>Custom Headers</strong>
          <p className="t-webhook-help v-muted-text">
            Sent with every delivery. Up to {MAX_HEADERS}; core&apos;s own
            X-Webhook-* headers cannot be overridden. Saved values are never
            shown: leave {HEADER_VALUE_MASK} in place to keep one.
          </p>
          {headers.map((row) => (
            <div key={row.key} className="t-webhook-header-row">
              <Input
                label="Name"
                value={row.name}
                onChange={(e) =>
                  updateHeader(row.key, { name: e.target.value })
                }
                placeholder="X-Api-Key"
              />
              <Input
                label="Value"
                value={row.value}
                onChange={(e) =>
                  updateHeader(row.key, { value: e.target.value })
                }
              />
              <IconButton
                icon={faTrash}
                title="Remove header"
                variant="danger"
                size="sm"
                onClick={() =>
                  setHeaders((rows) => rows.filter((r) => r.key !== row.key))
                }
              />
            </div>
          ))}
          {headers.length < MAX_HEADERS && (
            <div>
              <IconButton
                icon={faPlus}
                variant="secondary"
                size="sm"
                onClick={() => setHeaders((rows) => [...rows, newRow()])}
              >
                Add header
              </IconButton>
            </div>
          )}
        </Col>

        {error && <FormError>{error}</FormError>}
      </Col>
    </Form>
  );
};
