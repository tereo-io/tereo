import type { NotificationConnection } from "../../../prisma/generated/client/index.js";
import { emitTx, logAuditTx, type AuditLogInput } from "../outbox.js";
import { getDefaultOrganizationId } from "../defaultOrganization.js";
import { connectionSecretName } from "./connections.js";
import { sealRowSecret } from "../sealedSecrets.js";
import type { Prisma } from "../db/prisma.js";
import { AppError } from "../errors.js";
import type { z } from "zod";

type Tx = Prisma.TransactionClient;

const ENTITY_TYPE = "NotificationConnection";

/** Never includes the sealed secrets. */
export const formatConnection = (c: NotificationConnection) => ({
  id: c.id,
  channel: c.channel,
  slug: c.slug,
  displayName: c.displayName,
  isDefault: c.isDefault,
  isEnabled: c.isEnabled,
  settings: c.settings,
  hasSecrets: c.secrets !== null,
  maxPerMinute: c.maxPerMinute,
  createdBy: c.createdBy,
  updatedBy: c.updatedBy,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

export const eventData = (c: NotificationConnection) => ({
  id: c.id,
  channel: c.channel,
  slug: c.slug,
  displayName: c.displayName,
  isDefault: c.isDefault,
  isEnabled: c.isEnabled,
});

/** Audit metadata and diffs: the formatted view, which has no secrets. */
export const auditView = (c: NotificationConnection) => {
  const { createdAt, updatedAt, ...rest } = formatConnection(c);
  void createdAt;
  void updatedAt;
  return rest as Record<string, unknown>;
};

const issuesOf = (error: z.ZodError) =>
  error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));

export const parseWith = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: "invalid_settings" | "invalid_secrets"
): T => {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = issuesOf(result.error);
  const what = code === "invalid_settings" ? "Settings" : "Secrets";
  const summary = issues
    .map((i) => `${i.path || "(root)"}: ${i.message}`)
    .join(", ");
  throw new AppError(
    400,
    code,
    `${what} are not valid for this channel: ${summary}`,
    { details: { issues } }
  );
};

/** Serialises changes to a channel's default across transactions. */
export const lockChannel = (tx: Tx, channel: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`notification-connections:${channel}`}))`;

export const record = async (
  tx: Tx,
  auth: AuditLogInput["auth"],
  action: "CREATE" | "UPDATE" | "DELETE",
  connection: NotificationConnection,
  changes?: Record<string, { old: unknown; new: unknown }>,
  /** For an UPDATE: what `changes` can't show, e.g. that secrets changed. */
  updateMetadata?: Record<string, unknown>
) => {
  await logAuditTx(tx, {
    auth,
    action,
    entityType: ENTITY_TYPE,
    entityId: connection.id,
    entityName: `${connection.channel}/${connection.slug}`,
    changes: changes,
    metadata:
      action === "CREATE" || action === "DELETE"
        ? auditView(connection)
        : updateMetadata,
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: `notification.connection.${action.toLowerCase()}d`,
    entityType: ENTITY_TYPE,
    entityId: connection.id,
    data: eventData(connection),
  });
};

export const seal = (id: string, secrets: unknown) =>
  sealRowSecret(connectionSecretName(id), JSON.stringify(secrets));
