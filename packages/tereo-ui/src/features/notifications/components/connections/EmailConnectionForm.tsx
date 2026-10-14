import { useState } from "react";
import "../styles.css";
import {
  Badge,
  Col,
  Form,
  FormError,
  Input,
  Row,
  Select,
  Switch,
} from "@kosmeo-ui/react";
import type {
  EmailSecurity,
  FieldIssue,
  NotificationConnection,
} from "../../api/types";

export interface ConnectionFormValues {
  /** Create only; the slug is fixed afterwards. */
  slug?: string;
  displayName: string;
  settings: Record<string, unknown>;
  /** Left out when the password was not touched, so core keeps the stored one. `null` clears it. */
  secrets?: { password: string } | null;
  isEnabled: boolean;
  maxPerMinute: number | null;
}

interface EmailConnectionFormProps {
  connection?: NotificationConnection;
  onSubmit: (values: ConnectionFormValues) => void;
  formId?: string;
  /** Core's refusal of the last submit, shown under the fields it names. */
  issues?: FieldIssue[];
  /** Options from the channel's settings schema; defaults to every transport security. */
  securityOptions?: string[];
}

const SECURITY_LABELS: Record<string, string> = {
  tls: "TLS (implicit, usually port 465)",
  starttls: "STARTTLS (usually port 587)",
  none: "None (plain text)",
};

const DEFAULT_SECURITY: EmailSecurity[] = ["tls", "starttls", "none"];

// Issue paths with a field of their own; the rest are listed below the form.
const FIELD_PATHS = [
  "host",
  "port",
  "security",
  "username",
  "password",
  "defaultFrom",
  "defaultFrom.address",
  "defaultFrom.name",
  "allowedSenders",
];

const str = (v: unknown, fallback = "") =>
  typeof v === "string" ? v : fallback;

export const EmailConnectionForm = ({
  connection,
  onSubmit,
  formId,
  issues = [],
  securityOptions = DEFAULT_SECURITY,
}: EmailConnectionFormProps) => {
  const s = (connection?.settings ?? {}) as Record<string, unknown>;
  const from = (s.defaultFrom ?? {}) as Record<string, unknown>;

  const [displayName, setDisplayName] = useState(connection?.displayName ?? "");
  const [slug, setSlug] = useState("");
  const [isEnabled, setIsEnabled] = useState(connection?.isEnabled ?? true);
  const [host, setHost] = useState(str(s.host));
  const [port, setPort] = useState(String(s.port ?? 587));
  const [security, setSecurity] = useState(str(s.security, "starttls"));
  const [username, setUsername] = useState(str(s.username));
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [fromAddress, setFromAddress] = useState(str(from.address));
  const [fromName, setFromName] = useState(str(from.name));
  const [senders, setSenders] = useState<string[]>(
    Array.isArray(s.allowedSenders) ? (s.allowedSenders as string[]) : []
  );
  const [senderDraft, setSenderDraft] = useState("");
  const [maxPerMinute, setMaxPerMinute] = useState(
    connection?.maxPerMinute != null ? String(connection.maxPerMinute) : ""
  );
  const [error, setError] = useState<string | null>(null);

  const hasStoredSecrets = !!connection?.hasSecrets;
  // Core won't send the stored password to another server or account: a
  // change to any of these needs it typed again (or removed).
  const passwordRequired =
    hasStoredSecrets &&
    !removePassword &&
    (host.trim() !== str(s.host) ||
      Number(port) !== s.port ||
      security !== str(s.security) ||
      username.trim() !== str(s.username));

  const issueAt = (...paths: string[]) =>
    issues.find((i) => paths.includes(i.path))?.message;
  const senderIssue =
    issueAt("allowedSenders") ??
    issues.find((i) => i.path.startsWith("allowedSenders."))?.message;
  const otherIssues = issues.filter(
    (i) =>
      !FIELD_PATHS.includes(i.path) && !i.path.startsWith("allowedSenders.")
  );

  const addSender = (value: string) => {
    const v = value.trim().toLowerCase();
    if (v && !senders.includes(v)) setSenders((list) => [...list, v]);
    setSenderDraft("");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const draft = senderDraft.trim().toLowerCase();
    const allowedSenders =
      draft && !senders.includes(draft) ? [...senders, draft] : senders;
    if (allowedSenders.length === 0) {
      setError("Add at least one allowed sender.");
      return;
    }
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setError("The port must be a whole number from 1 to 65535.");
      return;
    }
    if (passwordRequired && !password) {
      setError(
        "Enter the password again: changing the host, port, security or username needs it."
      );
      return;
    }
    setError(null);

    const defaultFrom: Record<string, string> = { address: fromAddress.trim() };
    if (fromName.trim()) defaultFrom.name = fromName.trim();

    const settings: Record<string, unknown> = {
      host: host.trim(),
      port: portNumber,
      security,
      defaultFrom,
      allowedSenders,
    };
    if (username.trim()) settings.username = username.trim();

    const values: ConnectionFormValues = {
      displayName: displayName.trim(),
      settings,
      isEnabled,
      maxPerMinute: maxPerMinute.trim() ? Number(maxPerMinute) : null,
    };
    if (!connection) values.slug = slug.trim();
    if (removePassword && hasStoredSecrets) values.secrets = null;
    else if (password) values.secrets = { password };

    onSubmit(values);
  };

  return (
    <Form onSubmit={handleSubmit} id={formId}>
      <Col>
        <Input
          label="Name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          max={100}
          placeholder="Company SMTP"
        />
        {!connection && (
          <Input
            label="Slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
            max={50}
            placeholder="company-smtp"
            helperText="What a send names to pick this connection. Lowercase letters, digits and hyphens; fixed once created."
          />
        )}
        <Switch
          label="Enabled"
          checked={isEnabled}
          onChange={(e) => setIsEnabled(e.target.checked)}
        />

        <strong>Server</strong>
        <Row>
          <Input
            label="Host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            required
            max={255}
            placeholder="smtp.example.com"
            error={issueAt("host")}
          />
          <Input
            label="Port"
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            required
            min={1}
            max={65535}
            error={issueAt("port")}
          />
        </Row>
        <Select
          label="Security"
          value={security}
          onChange={(v) => v && setSecurity(v)}
          options={securityOptions.map((value) => ({
            value,
            label: SECURITY_LABELS[value] ?? value,
          }))}
        />
        {issueAt("security") && <FormError>{issueAt("security")}</FormError>}
        <Row>
          <Input
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            max={255}
            error={issueAt("username")}
          />
          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder={hasStoredSecrets ? "Unchanged" : undefined}
            disabled={removePassword}
            helperText={
              passwordRequired
                ? "Required again, since the server or account changed."
                : hasStoredSecrets
                  ? "Stored and never shown. Leave empty to keep it."
                  : "Stored encrypted and never shown again."
            }
            error={issueAt("password")}
          />
        </Row>
        {hasStoredSecrets && (
          <label className="t-notif-check">
            <input
              type="checkbox"
              checked={removePassword}
              onChange={(e) => {
                setRemovePassword(e.target.checked);
                if (e.target.checked) setPassword("");
              }}
            />
            Remove the stored password
          </label>
        )}

        <strong>Sender</strong>
        <Row>
          <Input
            label="From address"
            type="email"
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
            required
            max={320}
            placeholder="no-reply@example.com"
            error={issueAt("defaultFrom.address", "defaultFrom")}
          />
          <Input
            label="From name"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            max={200}
            placeholder="Example Co"
            error={issueAt("defaultFrom.name")}
          />
        </Row>
        <Col size="sm">
          <Input
            label="Allowed senders"
            value={senderDraft}
            onChange={(e) => setSenderDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addSender(senderDraft);
              }
            }}
            onBlur={() => addSender(senderDraft)}
            placeholder="no-reply@example.com or @example.com"
            helperText="Addresses a send may use as its From; the default From must match one. Press Enter to add."
            error={senderIssue}
          />
          {senders.length > 0 && (
            <Row size="sm" wrap>
              {senders.map((sender) => (
                <Badge
                  key={sender}
                  variant="secondary"
                  onRemove={() =>
                    setSenders((list) => list.filter((x) => x !== sender))
                  }
                >
                  {sender}
                </Badge>
              ))}
            </Row>
          )}
        </Col>

        <Input
          label="Max per minute"
          type="number"
          value={maxPerMinute}
          onChange={(e) => setMaxPerMinute(e.target.value)}
          min={1}
          placeholder="No limit"
          helperText="Caps how many messages this connection sends each minute."
        />

        {otherIssues.map((i) => (
          <FormError key={`${i.path}:${i.message}`}>
            {i.path ? `${i.path}: ${i.message}` : i.message}
          </FormError>
        ))}
        {error && <FormError>{error}</FormError>}
      </Col>
    </Form>
  );
};
