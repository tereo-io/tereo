import { BlockedAddressError, resolveSafeAddresses } from "../../ssrfGuard.js";
import nodemailer, { type Transporter } from "nodemailer";
import { isAllowedSender } from "../addresses.js";
import { BadRequestError } from "../../errors.js";
import { logger } from "../../logger.js";
import type { Readable } from "stream";
import { createHash } from "crypto";
import env from "../../../env.js";
import { z } from "zod";
import {
  PermanentSendError,
  type ChannelAdapter,
  type ConnectionView,
  type ResolvedRecipient,
  type SendContext,
  type SendResult,
} from "./types.js";

/**
 * `idleMs` only bounds the gaps between bytes, so a server that drips its
 * replies would hold a send open indefinitely. `totalMs` bounds the whole
 * send, well inside the 15 minutes after which the stale sweep takes a
 * `sending` delivery for lost and queues it again.
 */
export const smtpTimeouts = {
  connectMs: 30_000,
  idleMs: 60_000,
  totalMs: 10 * 60_000,
};

const noLineBreaks = (v: string) => !/[\r\n]/.test(v);
const headerText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(noLineBreaks, "must not contain line breaks");

// A display name that looks like an address ("ceo@bank.com" <x@acme.com>)
// would show a sender the allowlist never checked.
const displayName = headerText(200).refine(
  (v) => !/[<>@"]/.test(v),
  'must not contain <, >, @ or "'
);

const address = z.object({
  address: z.email().max(320),
  name: displayName.optional(),
});

const settingsSchema = z
  .object({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    security: z.enum(["tls", "starttls", "none"]),
    username: z.string().min(1).max(255).optional(),
    defaultFrom: address,
    allowedSenders: z.array(z.string().min(1).max(320).toLowerCase()).min(1),
  })
  .superRefine((s, ctx) => {
    if (!isAllowedSender(s.defaultFrom.address, s.allowedSenders)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultFrom"],
        message: "defaultFrom must match allowedSenders",
      });
    }
    if (s.security === "none" && !env.ALLOW_PLAINTEXT_SMTP) {
      ctx.addIssue({
        code: "custom",
        path: ["security"],
        message: 'security "none" needs ALLOW_PLAINTEXT_SMTP=true',
      });
    }
  });

const secretsSchema = z.object({ password: z.string().max(1000).optional() });

const contentSchema = z
  .object({
    subject: headerText(998),
    text: z.string().min(1).optional(),
    html: z.string().min(1).optional(),
    from: address.optional(),
    replyTo: z.email().max(320).optional(),
  })
  .refine((c) => c.text !== undefined || c.html !== undefined, {
    message: "text or html is required",
  });

// Strict: a misspelt `as` must not quietly put a Bcc recipient in To.
const recipientOptionsSchema = z.strictObject({
  as: z.enum(["to", "cc", "bcc"]).default("to"),
});

type Settings = z.infer<typeof settingsSchema>;
type Secrets = z.infer<typeof secretsSchema>;
type Content = z.infer<typeof contentSchema>;
type Options = z.infer<typeof recipientOptionsSchema>;

const RANK = { to: 0, cc: 1, bcc: 2 } as const;

// The transport pins the resolved IP, so an entry is rebuilt after a while to
// follow DNS changes.
const TRANSPORT_TTL_MS = 5 * 60_000;
const transports = new Map<string, { transport: Transporter; at: number }>();

// Everything the transport is built from, so an edit to the connection (or a
// change of the env flag) yields a new key.
const transportFingerprint = (
  connection: ConnectionView<Settings>,
  secrets: Secrets
): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        connection.settings,
        secrets,
        env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS,
      ])
    )
    .digest("hex");

async function transportFor(
  connection: ConnectionView<Settings>,
  secrets: Secrets
): Promise<Transporter> {
  const s = connection.settings;
  const key = `${connection.id}:${transportFingerprint(connection, secrets)}`;
  const cached = transports.get(key);
  if (cached && Date.now() - cached.at < TRANSPORT_TTL_MS) {
    return cached.transport;
  }

  let host = s.host;
  if (!env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS) {
    try {
      host = (await resolveSafeAddresses(s.host))[0].address;
    } catch (err) {
      // The guard's own text names the resolved address; an admin who can
      // type hosts must not learn what internal names resolve to.
      if (err instanceof BlockedAddressError) {
        throw new PermanentSendError(
          "host_not_allowed",
          "The SMTP host resolves to a private or reserved address"
        );
      }
      logger.warn(
        { err, connectionId: connection.id },
        "SMTP host did not resolve"
      );
      throw new Error("The SMTP host did not resolve");
    }
  }
  const transport = nodemailer.createTransport({
    host,
    port: s.port,
    secure: s.security === "tls",
    requireTLS: s.security === "starttls",
    ignoreTLS: s.security === "none",
    auth: s.username
      ? { user: s.username, pass: secrets.password ?? "" }
      : undefined,
    connectionTimeout: smtpTimeouts.connectMs,
    socketTimeout: smtpTimeouts.idleMs,
    // The connection goes to the pinned IP; the certificate is checked
    // against the name the admin typed.
    tls: { servername: s.host },
  });

  for (const [k, old] of transports) {
    if (k.startsWith(`${connection.id}:`)) {
      old.transport.close();
      transports.delete(k);
    }
  }
  transports.set(key, { transport, at: Date.now() });
  return transport;
}

const mailbox = (a: { address: string; name?: string }) =>
  a.name ? { name: a.name, address: a.address } : a.address;

async function deliver(
  deliveryId: string,
  connection: ConnectionView<Settings>,
  secrets: Secrets,
  content: Content,
  recipients: ResolvedRecipient<Options>[],
  attachments: SendContext<Settings, Secrets, Content>["attachments"]
): Promise<SendResult> {
  const transport = await transportFor(connection, secrets);
  const from = content.from ?? connection.settings.defaultFrom;
  const domain = from.address.slice(from.address.lastIndexOf("@") + 1);
  const pick = (as: Options["as"]) =>
    recipients.filter((r) => r.options.as === as).map((r) => r.address);

  // A failed send may leave streams unread; each holds a file open until
  // destroyed.
  const opened: Readable[] = [];
  let sent = false;
  try {
    const files = [];
    for (const a of attachments) {
      const stream = await a.open();
      opened.push(stream);
      files.push({
        filename: a.filename,
        contentType: a.contentType,
        content: stream,
      });
    }
    const info = await withDeadline(
      transport.sendMail({
        messageId: `<${deliveryId}@${domain}>`,
        from: mailbox(from),
        replyTo: content.replyTo,
        to: pick("to"),
        cc: pick("cc"),
        bcc: pick("bcc"),
        subject: content.subject,
        text: content.text,
        html: content.html,
        attachments: files,
      })
    );
    sent = true;
    // Refused at RCPT while others were accepted: the send succeeded, but the
    // log must not read as if everyone got it.
    const rejected = (
      (info.rejected ?? []) as (string | { address: string })[]
    ).map((r) => (typeof r === "string" ? r : r.address));
    const response = info.response ?? null;
    return {
      providerMessageId: info.messageId ?? null,
      providerResponse:
        rejected.length > 0
          ? `${response ?? ""}; rejected: ${rejected.join(", ")}`
          : response,
    };
  } catch (err) {
    const code = (err as { responseCode?: number }).responseCode;
    if (typeof code === "number" && code >= 500) {
      throw new PermanentSendError("smtp_rejected", (err as Error).message);
    }
    throw err;
  } finally {
    if (!sent) for (const stream of opened) stream.destroy();
  }
}

/**
 * Rejects once `smtpTimeouts.totalMs` has passed. Nodemailer can't cancel the
 * send itself (the caller's `finally` only destroys its attachment streams),
 * so the delivery is retried while the late send may still complete. That is
 * deliberate: no mail is lost, at the cost of a rare duplicate.
 */
function withDeadline<T>(send: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `SMTP send did not finish within ${smtpTimeouts.totalMs / 1000} s`
          )
        ),
      smtpTimeouts.totalMs
    );
  });
  send.catch(() => undefined);
  return Promise.race([send, deadline]).finally(() => clearTimeout(timer));
}

export const emailAdapter: ChannelAdapter<Settings, Secrets, Content, Options> =
  {
    channel: "email",
    settingsSchema,
    secretsSchema,
    contentSchema,
    recipientOptionsSchema,
    maxRecipients: 50,
    maxAttachmentBytes: 20 * 1024 * 1024,
    secretBoundSettings: ["host", "port", "security", "username"],

    validate(connection, content) {
      const { allowedSenders } = connection.settings;
      if (
        content.from &&
        !isAllowedSender(content.from.address, allowedSenders)
      ) {
        throw new BadRequestError(
          "sender_not_allowed",
          `Sender ${content.from.address} is not allowed on this connection`
        );
      }
      if (
        content.replyTo &&
        !isAllowedSender(content.replyTo, allowedSenders)
      ) {
        throw new BadRequestError(
          "sender_not_allowed",
          `Reply-To ${content.replyTo} is not allowed on this connection`
        );
      }
    },

    summarize(content) {
      return content.subject;
    },

    resolveUser(user) {
      return user.isActive && user.userType === "human" ? user.email : null;
    },

    plan(recipients) {
      const best = new Map<string, ResolvedRecipient<Options>>();
      for (const r of recipients) {
        const key = r.address.toLowerCase();
        const held = best.get(key);
        if (!held || RANK[r.options.as] < RANK[held.options.as]) {
          best.set(key, r);
        }
      }
      const unique = [...best.values()];
      if (!unique.some((r) => r.options.as === "to")) {
        throw new PermanentSendError(
          "invalid_content",
          "An email needs at least one `to` recipient"
        );
      }
      return [{ recipients: unique }];
    },

    send(ctx) {
      return deliver(
        ctx.deliveryId,
        ctx.connection,
        ctx.secrets,
        ctx.content,
        ctx.recipients as ResolvedRecipient<Options>[],
        ctx.attachments
      );
    },

    test(connection, secrets, to) {
      return deliver(
        `test-${crypto.randomUUID()}`,
        connection,
        secrets,
        {
          subject: "Test message",
          text: "This is a test message from your notifications connection.",
        },
        [{ address: to, userId: null, options: { as: "to" } }],
        []
      );
    },
  };
