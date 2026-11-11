import type { User } from "../../../../prisma/generated/client/index.js";
import type { Readable } from "stream";
import type { z } from "zod";

export type NotificationChannel = "email";

export interface ConnectionView<S> {
  id: string;
  slug: string;
  channel: NotificationChannel;
  settings: S;
}

export interface RecipientInput {
  address?: string;
  userId?: string;
  [option: string]: unknown;
}

export interface ResolvedRecipient<O> {
  address: string;
  userId: string | null;
  options: O;
}

export interface DeliveryPlan<O> {
  recipients: ResolvedRecipient<O>[];
}

export interface AttachmentStream {
  filename: string;
  contentType: string;
  size: number;
  open(): Promise<Readable>;
}

export interface SendContext<S, K, C> {
  deliveryId: string;
  connection: ConnectionView<S>;
  secrets: K;
  content: C;
  recipients: ResolvedRecipient<unknown>[];
  attachments: AttachmentStream[];
}

export interface SendResult {
  providerMessageId: string | null;
  providerResponse: string | null;
}

/** A failure a retry cannot fix. */
export class PermanentSendError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PermanentSendError";
  }
}

/** A failure a retry may fix, raised by core: its message is safe to show. */
export class RetryableSendError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableSendError";
  }
}

/**
 * A library's failure as it may be shown: the server's SMTP reply when there
 * was one, else the error's code, else null. Not its message, which names
 * the host and the address it resolved to, or quotes whatever a non-SMTP
 * service there answered.
 */
export const providerReplyOrCode = (err: unknown): string | null => {
  const e = err as {
    responseCode?: unknown;
    response?: unknown;
    code?: unknown;
  };
  if (typeof e?.responseCode === "number" && typeof e.response === "string") {
    return e.response.slice(0, 500);
  }
  return typeof e?.code === "string" ? e.code : null;
};

export interface ChannelAdapter<S, K, C, O> {
  channel: NotificationChannel;
  settingsSchema: z.ZodType<S>;
  secretsSchema: z.ZodType<K>;
  contentSchema: z.ZodType<C>;
  recipientOptionsSchema: z.ZodType<O>;
  /** Most recipients one request may name, counted before `plan()`. */
  maxRecipients: number;
  /** Null: the channel takes no attachments. */
  maxAttachmentBytes: number | null;
  /**
   * Settings that say where the secrets are sent (email: the server and the
   * account). Changing one needs the secrets again, so the stored ones are
   * never handed to an endpoint they were not entered for.
   */
  secretBoundSettings: readonly (keyof S & string)[];

  /** Accept-time checks needing the connection, e.g. `from` against allowed senders. */
  validate(connection: ConnectionView<S>, content: C): void;
  /** A one-line description of the content for the log (email: the subject). */
  summarize(content: C): string | null;
  /** Resolve a core user to this channel's address, or null when the user has none. */
  resolveUser(user: User): string | null;
  /** Split one notification into deliveries. Email: one; SMS: one per number. */
  plan(recipients: ResolvedRecipient<O>[]): DeliveryPlan<O>[];
  /** Send one delivery. Throws PermanentSendError for failures a retry cannot fix. */
  send(ctx: SendContext<S, K, C>): Promise<SendResult>;
  /** The admin's "send test" button. */
  test(
    connection: ConnectionView<S>,
    secrets: K,
    to: string
  ): Promise<SendResult>;
}
