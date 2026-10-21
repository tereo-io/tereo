import type { NotificationConnection } from "../../../prisma/generated/client/index.js";
import { assertNotificationWriteScope } from "../../middleware/organizationId.js";
import { AppError, BadRequestError, ValidationError } from "../errors.js";
import { canReadBucket, holdsBucketGrant } from "../bucketAccess.js";
import { enqueueNotificationTx, logAuditTx } from "../outbox.js";
import type { AuthContext } from "../../middleware/auth.js";
import { CHANNELS, getAdapter } from "./channels/index.js";
import { toConnectionView } from "./connections.js";
import { hasNul, pgText } from "../pgInput.js";
import type { Prisma } from "../db/prisma.js";
import { prisma } from "../db/prisma.js";
import db from "../db/index.js";
import { z } from "zod";
import {
  PermanentSendError,
  type NotificationChannel,
  type RecipientInput,
  type ResolvedRecipient,
} from "./channels/types.js";

type Tx = Prisma.TransactionClient;

const ENTITY_TYPE = "Notification";
const singleAddress = z.email().max(320).toLowerCase();
const MAX_ATTACHMENTS = 50;

export interface NotificationInput {
  channel: NotificationChannel;
  connection?: string;
  organizationId?: string | null;
  recipients: RecipientInput[];
  content: unknown;
  attachments?: {
    bucket: string;
    objectId: string;
    versionId: string;
    filename?: string;
  }[];
}

export interface Sender {
  userId: string;
  email: string | null;
  /** "system": core itself, which may read every bucket. */
  auth: AuthContext | "system";
}

export interface StoredAttachment {
  bucket: string;
  objectId: string;
  versionId: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface ValidatedNotification {
  channel: NotificationChannel;
  /** The named connection; null sends through the channel's default. */
  connection: NotificationConnection | null;
  organizationId: string | null;
  /** As requested: `{ address }` or `{ userId }` with the parsed options. */
  recipients: Record<string, unknown>[];
  content: unknown;
  /** The channel's one-line description of `content`, for the log. */
  summary: string | null;
  attachments: StoredAttachment[];
  /** Each delivery's recipients: `{ address, ...options, userId? }`. */
  deliveries: Record<string, unknown>[][];
}

/**
 * The shape of a send. What the channel makes of `content` and the
 * recipients' options is checked against its adapter afterwards.
 */
export const notificationInputSchema = z.strictObject({
  channel: pgText().min(1).max(50),
  connection: pgText().min(1).max(50).optional(),
  organizationId: z.guid().nullish(),
  recipients: z.array(z.record(z.string(), z.unknown())).min(1),
  content: z.unknown(),
  attachments: z
    .array(
      z.strictObject({
        bucket: pgText().min(1).max(255),
        objectId: z.guid(),
        versionId: z.guid(),
        filename: z.string().min(1).max(255).optional(),
      })
    )
    .max(MAX_ATTACHMENTS)
    .optional(),
});

const summarize = (error: z.ZodError) =>
  error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join(", ");

const invalidContent = (message: string) =>
  new BadRequestError("invalid_content", message);

const attachmentNotFound = (a: { objectId: string; versionId: string }) =>
  new BadRequestError(
    "attachment_not_found",
    `No version ${a.versionId} of object ${a.objectId} to attach`
  );

type Adapter = ReturnType<typeof getAdapter>;

interface RequestedRecipient {
  address: string | null;
  userId: string | null;
  options: Record<string, unknown>;
}

const parseRecipient = (
  adapter: Adapter,
  recipient: Record<string, unknown>,
  index: number
): RequestedRecipient => {
  const { address, userId, ...rest } = recipient;
  if ((address === undefined) === (userId === undefined)) {
    throw invalidContent(
      `recipients.${index}: give exactly one of address and userId`
    );
  }
  // One address only: a mail library splits "a@x, b@y" into two recipients,
  // past the recipient cap. Stored lower-cased, so the log's recipient
  // filter matches whatever case it was given in.
  const parsedAddress = singleAddress.safeParse(address);
  if (address !== undefined && !parsedAddress.success) {
    throw invalidContent(`recipients.${index}.address: not an email address`);
  }
  const parsedUserId = z.guid().safeParse(userId);
  if (userId !== undefined && !parsedUserId.success) {
    throw invalidContent(`recipients.${index}.userId: not a user id`);
  }
  const options = adapter.recipientOptionsSchema.safeParse(rest);
  if (!options.success) {
    throw invalidContent(`recipients.${index}: ${summarize(options.error)}`);
  }
  return {
    address: parsedAddress.success ? parsedAddress.data : null,
    userId: parsedUserId.success ? parsedUserId.data : null,
    options: options.data as Record<string, unknown>,
  };
};

const resolveRecipients = async (
  adapter: Adapter,
  requested: RequestedRecipient[],
  client: Tx
): Promise<ResolvedRecipient<Record<string, unknown>>[]> => {
  const ids = [
    ...new Set(requested.flatMap((r) => (r.userId ? [r.userId] : []))),
  ];
  const users =
    ids.length === 0
      ? []
      : await client.user.findMany({ where: { id: { in: ids } } });
  const byId = new Map(users.map((u) => [u.id, u]));

  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new BadRequestError(
      "unknown_user",
      `No user with id: ${missing.join(", ")}`
    );
  }
  const inactive = users.filter((u) => !u.isActive || u.userType !== "human");
  if (inactive.length > 0) {
    throw new BadRequestError(
      "inactive_user",
      `Not an active person: ${inactive.map((u) => u.id).join(", ")}`
    );
  }

  return requested.map((r) => {
    if (r.address !== null) {
      return { address: r.address, userId: null, options: r.options };
    }
    const user = byId.get(r.userId!)!;
    const address = adapter.resolveUser(user)?.toLowerCase();
    if (!address) {
      throw invalidContent(`User ${user.id} has no ${adapter.channel} address`);
    }
    // Held to the same one-address rule: a stored email came from wherever
    // the account did (an identity provider's claim, say), not this check.
    if (!singleAddress.safeParse(address).success) {
      throw invalidContent(
        `User ${user.id}'s ${adapter.channel} address is not a single address`
      );
    }
    return { address, userId: user.id, options: r.options };
  });
};

const basename = (key: string) =>
  key.slice(key.lastIndexOf("/") + 1).replace(/[\r\n]/g, "_");

const resolveAttachments = async (
  sender: Sender,
  adapter: Adapter,
  attachments: NonNullable<NotificationInput["attachments"]>,
  client: Tx
): Promise<StoredAttachment[]> => {
  if (attachments.length === 0) return [];
  if (adapter.maxAttachmentBytes === null) {
    throw invalidContent(`The ${adapter.channel} channel takes no attachments`);
  }

  const readable = new Map<string, boolean>();
  const historyReadable = new Map<string, boolean>();
  const stored: StoredAttachment[] = [];
  let total = 0;
  for (const a of attachments) {
    if (sender.auth !== "system") {
      let canRead = readable.get(a.bucket);
      if (canRead === undefined) {
        canRead = await canReadBucket(sender.auth, a.bucket);
        readable.set(a.bucket, canRead);
      }
      // A missing bucket is refused alike, so a sender can't probe for names.
      if (!canRead) {
        throw new AppError(
          403,
          "attachment_forbidden",
          `You cannot read bucket "${a.bucket}"`
        );
      }
    }
    const bucket = await client.bucket.findFirst({
      where: { name: a.bucket, deletedAt: null },
      select: { id: true, policy: true },
    });
    if (!bucket) throw attachmentNotFound(a);
    const object = await client.object.findFirst({
      where: {
        id: a.objectId,
        bucketId: bucket.id,
        deletedAt: null,
        thumbnailFor: null,
      },
      select: { objectKey: true },
    });
    if (!object) throw attachmentNotFound(a);
    const version = await client.objectVersion.findFirst({
      where: { id: a.versionId, objectId: a.objectId, deletedAt: null },
      include: { contentBlob: true },
    });
    if (!version || version.isDeleteMarker || !version.contentBlob) {
      throw attachmentNotFound(a);
    }
    // A public bucket serves its current content to anyone, but its history
    // only to grant holders, as the files API does.
    if (
      !version.isCurrent &&
      bucket.policy === "public" &&
      sender.auth !== "system"
    ) {
      let granted = historyReadable.get(a.bucket);
      if (granted === undefined) {
        granted = await holdsBucketGrant(sender.auth, a.bucket);
        historyReadable.set(a.bucket, granted);
      }
      if (!granted) throw attachmentNotFound(a);
    }

    const size = Number(version.contentBlob.sizeBytes);
    total += size;
    stored.push({
      bucket: a.bucket,
      objectId: a.objectId,
      versionId: a.versionId,
      filename: a.filename ?? (basename(object.objectKey) || a.objectId),
      contentType: version.contentType ?? "application/octet-stream",
      size,
    });
  }

  if (total > adapter.maxAttachmentBytes) {
    throw new BadRequestError(
      "attachments_too_large",
      `Attachments total ${total} bytes; the ${adapter.channel} channel takes at most ${adapter.maxAttachmentBytes}`
    );
  }
  return stored;
};

/**
 * Every accept-time check, in the order a sender would fix them. Reads only,
 * through `client`: a transaction's when called from one, so rows it wrote
 * are visible.
 */
export async function validateNotification(
  sender: Sender,
  raw: NotificationInput,
  client: Tx = prisma
): Promise<ValidatedNotification> {
  const parsed = notificationInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid notification. ${summarize(parsed.error)}`
    );
  }
  const input = parsed.data;

  if (!(CHANNELS as string[]).includes(input.channel)) {
    throw new BadRequestError(
      "unknown_channel",
      `Unknown channel "${input.channel}"; core supports: ${CHANNELS.join(", ")}`
    );
  }
  const channel = input.channel as NotificationChannel;
  const adapter = getAdapter(channel);

  let connection: NotificationConnection | null = null;
  if (input.connection !== undefined) {
    connection = await db.notificationConnections.getBySlug(
      channel,
      input.connection,
      client
    );
    if (!connection) {
      throw new BadRequestError(
        "unknown_connection",
        `No ${channel} connection "${input.connection}"`
      );
    }
    if (!connection.isEnabled) {
      throw new AppError(
        409,
        "connection_disabled",
        `The ${channel} connection "${input.connection}" is disabled`
      );
    }
  }

  if (hasNul(input.recipients) || hasNul(input.content)) {
    throw invalidContent("The notification contains a NUL character");
  }
  if (input.recipients.length > adapter.maxRecipients) {
    throw new BadRequestError(
      "too_many_recipients",
      `A ${channel} notification takes at most ${adapter.maxRecipients} recipients`
    );
  }
  const requested = input.recipients.map((r, i) =>
    parseRecipient(adapter, r, i)
  );
  const content = adapter.contentSchema.safeParse(input.content);
  if (!content.success) {
    throw invalidContent(
      `Invalid ${channel} content: ${summarize(content.error)}`
    );
  }
  for (const [i, a] of (input.attachments ?? []).entries()) {
    if (/[\r\n\0]/.test(a.filename ?? "")) {
      throw invalidContent(
        `attachments.${i}.filename: must not contain line breaks`
      );
    }
  }

  // With no connection named and no default yet, the send is accepted and
  // waits; the delivery worker checks it once a connection exists.
  const against =
    connection ??
    (await db.notificationConnections.getDefault(channel, client));
  if (against) adapter.validate(toConnectionView(against), content.data);

  const resolved = await resolveRecipients(adapter, requested, client);
  const attachments = await resolveAttachments(
    sender,
    adapter,
    input.attachments ?? [],
    client
  );

  // Left out, it is the token's organization: null would file the audit entry
  // and events under the default organization, outside the sender's scope.
  const organizationId =
    input.organizationId ??
    (sender.auth === "system" ? null : sender.auth.organizationId) ??
    null;
  if (organizationId && sender.auth !== "system") {
    await assertNotificationWriteScope(sender.auth, [organizationId]);
  }
  if (
    organizationId &&
    !(await client.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    }))
  ) {
    throw new BadRequestError(
      "unknown_organization",
      `No organization with id: ${organizationId}`
    );
  }

  let plans;
  try {
    plans = adapter.plan(resolved);
  } catch (err) {
    if (err instanceof PermanentSendError) {
      throw new BadRequestError(err.code, err.message);
    }
    throw err;
  }

  return {
    channel,
    connection,
    organizationId,
    recipients: requested.map((r) => ({
      ...(r.address !== null ? { address: r.address } : { userId: r.userId }),
      ...r.options,
    })),
    content: content.data,
    summary: adapter.summarize(content.data),
    attachments,
    deliveries: plans.map((plan) =>
      plan.recipients.map((r) => ({
        address: r.address,
        ...(r.options as Record<string, unknown>),
        ...(r.userId !== null && { userId: r.userId }),
      }))
    ),
  };
}

export const senderAccessSchema = z.object({
  organizationId: z.guid().nullable(),
  ceiling: z.array(z.string()).optional(),
});

/** What the delivery worker needs to check attachment access as at accept. */
const senderAccessOf = (
  auth: AuthContext
): z.infer<typeof senderAccessSchema> => ({
  organizationId: auth.organizationId,
  ...(auth.ceiling && { ceiling: auth.ceiling }),
});

/** Writes a validated notification, its deliveries, audit entry and outbox row. */
export async function writeNotification(
  tx: Tx,
  sender: Sender,
  notification: ValidatedNotification
): Promise<{ id: string; createdAt: Date }> {
  const json = (value: unknown) => value as Prisma.InputJsonValue;
  const row = await db.notifications.insert(
    tx,
    {
      channel: notification.channel,
      connectionId: notification.connection?.id ?? null,
      senderUserId: sender.userId,
      organizationId: notification.organizationId,
      recipients: json(notification.recipients),
      content: json(notification.content),
      summary: notification.summary,
      attachments: json(notification.attachments),
      ...(sender.auth !== "system" && {
        senderAccess: json(senderAccessOf(sender.auth)),
      }),
    },
    notification.deliveries.map((recipients) => ({
      recipients: json(recipients),
    }))
  );

  await logAuditTx(tx, {
    auth: { userId: sender.userId, email: sender.email },
    organizationId: notification.organizationId,
    action: "CREATE",
    entityType: ENTITY_TYPE,
    entityId: row.id,
    entityName: notification.channel,
    metadata: {
      channel: notification.channel,
      connection: notification.connection?.slug ?? null,
      recipients: notification.recipients.length,
      deliveries: notification.deliveries.length,
      attachments: notification.attachments.length,
    },
  });
  await enqueueNotificationTx(tx, row);
  return { id: row.id, createdAt: row.createdAt };
}

/** Validates and writes notification + deliveries + outbox row in `tx`. */
export async function acceptNotification(
  tx: Tx,
  sender: Sender,
  input: NotificationInput
): Promise<{ id: string; createdAt: Date }> {
  const notification = await validateNotification(sender, input, tx);
  return writeNotification(tx, sender, notification);
}
