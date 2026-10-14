// Shapes returned by core's notifications admin area
// (`/v1/admin/notifications/...`). See packages/tereo/openapi/components/notifications.

export type NotificationChannel = "email";

export type EmailSecurity = "tls" | "starttls" | "none";

export interface EmailAddress {
  address: string;
  name?: string;
}

export interface EmailSettings {
  host: string;
  port: number;
  security: EmailSecurity;
  username?: string;
  defaultFrom: EmailAddress;
  allowedSenders: string[];
}

export interface NotificationConnection {
  id: string;
  channel: NotificationChannel;
  /** Unique per channel; fixed once created. */
  slug: string;
  displayName: string;
  isDefault: boolean;
  isEnabled: boolean;
  settings: Record<string, unknown>;
  /** Secrets are never returned; this says whether any are stored. */
  hasSecrets: boolean;
  maxPerMinute: number | null;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationChannelInfo {
  channel: NotificationChannel;
  /** JSON Schema of `settings`. */
  settingsSchema: Record<string, unknown>;
  secretsSchema: Record<string, unknown>;
}

export interface CreateConnectionInput {
  channel: NotificationChannel;
  slug: string;
  displayName: string;
  settings: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  isEnabled?: boolean;
  maxPerMinute?: number | null;
}

/** `settings` replaces the whole object; `secrets: null` clears the stored ones. */
export interface UpdateConnectionInput {
  displayName?: string;
  settings?: Record<string, unknown>;
  secrets?: Record<string, unknown> | null;
  isEnabled?: boolean;
  maxPerMinute?: number | null;
}

export type TestConnectionResult =
  { ok: true; providerResponse: string | null } | { ok: false; error: string };

export interface FieldIssue {
  /** Dotted path to the field; empty for the object itself. */
  path: string;
  message: string;
}

export type NotificationStatus = "pending" | "sent" | "partial" | "failed";
export type DeliveryStatus = "pending" | "sending" | "sent" | "failed";

export interface NotificationRecipient {
  address?: string;
  userId?: string;
  /** Email: the header the recipient goes in. */
  as?: "to" | "cc" | "bcc";
}

export interface NotificationAttachment {
  bucket: string;
  objectId: string;
  versionId: string;
  filename: string;
  contentType: string;
  size: number;
}

/** A row of the log list; the message content and deliveries are not in it. */
export interface NotificationLogEntry {
  id: string;
  channel: NotificationChannel;
  connectionId: string | null;
  senderUserId: string;
  organizationId: string | null;
  status: NotificationStatus;
  /** One line from the channel (email: the subject); kept after the content is dropped. */
  summary: string | null;
  recipients: NotificationRecipient[];
  attachments: NotificationAttachment[];
  createdAt: string;
  updatedAt: string;
}

/** A row of the list: an entry with when its latest delivery was sent. */
export interface NotificationLogListItem extends NotificationLogEntry {
  sentAt: string | null;
}

export interface NotificationLogDelivery {
  id: string;
  connectionId: string | null;
  recipients: { address: string; userId?: string }[];
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  providerMessageId: string | null;
  providerResponse: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationLogDetail extends NotificationLogEntry {
  /** For email: subject, text, html, from, replyTo. Null once every delivery is sent. */
  content: Record<string, unknown> | null;
  deliveries: NotificationLogDelivery[];
}

export interface NotificationLogFilters {
  channel?: NotificationChannel;
  status?: NotificationStatus;
  senderUserId?: string;
  recipient?: string;
  /** ISO date-times. */
  createdFrom?: string;
  createdTo?: string;
}
