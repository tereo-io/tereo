export type NotificationChannel = "email";

export interface EmailAddress {
  address: string;
  /** At most 200 characters; core refuses line breaks, `<`, `>`, `@` and `"`. */
  name?: string;
}

/** A raw address or a core user id; `as` places the recipient, default `to`. */
export type EmailRecipient = (
  { address: string; userId?: never } | { userId: string; address?: never }
) & { as?: "to" | "cc" | "bcc" };

export interface EmailContent {
  /** At most 998 characters. */
  subject: string;
  text?: string;
  html?: string;
  /** Must match the connection's allowed senders; defaults to the connection's From. */
  from?: EmailAddress;
  /** Must match the connection's allowed senders, like `from`. */
  replyTo?: string;
}

/** An object version in core's file storage, read at send time. */
export interface NotificationAttachment {
  bucket: string;
  objectId: string;
  versionId: string;
  filename?: string;
}

interface NotificationBase {
  /** A connection's slug; default: the channel's default connection. */
  connection?: string;
  organizationId?: string;
}

export type EmailNotificationInput = NotificationBase & {
  channel: "email";
  /** 1 to 50, at least one `to`. */
  recipients: EmailRecipient[];
  content: EmailContent;
  attachments?: NotificationAttachment[];
};

/** Body of `POST /v1/notifications`, less the idempotency key. A union on `channel`. */
export type NotificationInput = EmailNotificationInput;

export interface SendNotificationParams {
  idempotencyKey?: string;
}

export type SendNotificationInput = NotificationInput & SendNotificationParams;

export interface SendNotificationResult {
  id: string;
  status: "pending";
}

export interface NotificationDelivery {
  id: string;
  status: string;
  attempts: number;
  lastError: string | null;
  /** When it was sent (ISO 8601); null until then. */
  sentAt?: string | null;
  [key: string]: unknown;
}

export interface Notification {
  id: string;
  channel: NotificationChannel;
  status: string;
  /** One line for the log from the channel (email: the subject). */
  summary?: string | null;
  deliveries: NotificationDelivery[];
  [key: string]: unknown;
}
