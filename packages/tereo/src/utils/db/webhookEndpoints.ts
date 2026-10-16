import { Prisma } from "../../../prisma/generated/client/index.js";
import { newEndpointSecret } from "../webhookSecrets.js";
import { GetPaginatedOptions } from "./types.js";
import { NotFoundError } from "../errors.js";
import { userRefSelect } from "../refs.js";
import { prisma } from "./prisma.js";
import { v7 as uuidv7 } from "uuid";

export interface CreateWebhookEndpointInput {
  /** Null, with an owner, for an endpoint sent every organization's events. */
  organizationId: string | null;
  createdBy: string;
  ownerServiceId?: string | null;
  provisioned?: boolean;
  provisioningKey?: string | null;
  url: string;
  description?: string | null;
  eventTypes: string[];
  customHeaders?: Record<string, string> | null;
  /** Supplied (deterministic) signing secret; when absent a random one is generated. */
  signingSecret?: string;
}

export interface UpdateWebhookEndpointInput {
  url?: string;
  description?: string | null;
  eventTypes?: string[];
  status?: "ACTIVE" | "PAUSED";
  customHeaders?: Record<string, string> | null;
}

// Subscriptions live in `webhook_endpoint_event_types`. Every read includes
// them and returns them as `eventTypes: string[]`, the shape the API exposes,
// plus `retiredEventTypes`: those whose service no longer declares them, which
// will not fire again.
const include = {
  subscriptions: {
    select: { eventType: true, definition: { select: { retiredAt: true } } },
    orderBy: { eventType: "asc" },
  },
  creator: userRefSelect,
  ownerService: {
    select: {
      id: true,
      slug: true,
      name: true,
      kind: true,
      internalHost: true,
    },
  },
} satisfies Prisma.WebhookEndpointInclude;

type EndpointRow = Prisma.WebhookEndpointGetPayload<{
  include: typeof include;
}>;

const withEventTypes = <T extends EndpointRow>({
  subscriptions,
  ...endpoint
}: T) => ({
  ...endpoint,
  eventTypes: subscriptions.map((s) => s.eventType),
  retiredEventTypes: subscriptions
    .filter((s) => s.definition.retiredAt)
    .map((s) => s.eventType),
});

const orNull = <T extends EndpointRow>(row: T | null) =>
  row ? withEventTypes(row) : null;

export const findById = async (id: string) => {
  return orNull(
    await prisma.webhookEndpoint.findUnique({ where: { id }, include })
  );
};

export const getById = async (id: string) => {
  const endpoint = await findById(id);
  if (!endpoint) throw new NotFoundError("Webhook endpoint not found");
  return endpoint;
};

/** `getById`, holding the row locked until `tx` ends. */
export const getForUpdate = async (
  id: string,
  tx: Prisma.TransactionClient
) => {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "webhooks"."webhook_endpoints"
    WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (locked.length === 0)
    throw new NotFoundError("Webhook endpoint not found");
  return withEventTypes(
    await tx.webhookEndpoint.findUniqueOrThrow({ where: { id }, include })
  );
};

export const getPaginated = async (options: GetPaginatedOptions) => {
  const { take, orderBy, where: filterWhere } = options;
  const where = filterWhere ?? {};

  const rows = await prisma.webhookEndpoint.findMany({
    where,
    take: take + 1,
    orderBy,
    include,
  });

  const hasMore = rows.length > take;
  const data = (hasMore ? rows.slice(0, take) : rows).map(withEventTypes);

  return { data, hasMore };
};

/**
 * Returns the endpoint with its secret sealed, and the plaintext secret for
 * the one response that shows it.
 */
export const create = async (
  data: CreateWebhookEndpointInput,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  // The id is the secret's sealing name, so it is chosen before the insert.
  const id = uuidv7();
  const secret = await newEndpointSecret(id, data.signingSecret);

  const created = await db.webhookEndpoint.create({
    include,
    data: {
      id,
      organizationId: data.organizationId,
      createdBy: data.createdBy,
      ownerServiceId: data.ownerServiceId ?? null,
      provisioned: data.provisioned ?? false,
      provisioningKey: data.provisioningKey ?? null,
      url: data.url,
      description: data.description ?? null,
      signingSecret: secret.sealed,
      signingSecretHint: secret.hint,
      subscriptions: {
        create: [...new Set(data.eventTypes)].map((eventType) => ({
          eventType,
        })),
      },
      customHeaders:
        data.customHeaders !== undefined
          ? data.customHeaders === null
            ? Prisma.DbNull
            : (data.customHeaders as Prisma.InputJsonValue)
          : undefined,
    },
  });
  return { endpoint: withEventTypes(created), signingSecret: secret.plaintext };
};

export const update = async (
  id: string,
  data: UpdateWebhookEndpointInput,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  const { customHeaders, eventTypes, ...rest } = data;
  const updateData: Prisma.WebhookEndpointUpdateInput = { ...rest };

  // Replacing the list replaces the subscriptions.
  if (eventTypes !== undefined) {
    updateData.subscriptions = {
      deleteMany: {},
      create: [...new Set(eventTypes)].map((eventType) => ({ eventType })),
    };
  }

  if (customHeaders !== undefined) {
    updateData.customHeaders =
      customHeaders === null
        ? Prisma.DbNull
        : (customHeaders as Prisma.InputJsonValue);
  }

  // Re-activating starts the failure count over; otherwise the next exhausted
  // delivery would disable the endpoint again at once.
  if (rest.status === "ACTIVE") {
    await db.webhookEndpoint.updateMany({
      where: { id, status: { not: "ACTIVE" } },
      data: { consecutiveFailures: 0 },
    });
  }

  return withEventTypes(
    await db.webhookEndpoint.update({
      where: { id },
      data: updateData,
      include,
    })
  );
};

// Auto-disable path (repeated delivery failures). DISABLED stays a real
// operational status, independent of the archive lifecycle. Only an ACTIVE
// endpoint is disabled, so one an admin paused or re-enabled meanwhile is left
// alone; returns whether this call disabled it.
export const deactivate = async (
  id: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const db = tx ?? prisma;
  const result = await db.webhookEndpoint.updateMany({
    where: { id, status: "ACTIVE" },
    data: { status: "DISABLED" },
  });
  return result.count > 0;
};

// Archive is an additive lifecycle marker, orthogonal to `status`. The
// `archivedAt: null` guard makes the write idempotent/TOCTOU-safe; the
// controller 409s early on an already-archived row.
export const archive = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const result = await db.webhookEndpoint.updateMany({
    where: { id, archivedAt: null },
    data: { archivedAt: new Date() },
  });
  if (result.count === 0) return null;
  return orNull(
    await db.webhookEndpoint.findUnique({ where: { id }, include })
  );
};

export const restore = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const result = await db.webhookEndpoint.updateMany({
    where: { id, archivedAt: { not: null } },
    data: { archivedAt: null },
  });
  if (result.count === 0) return null;
  return orNull(
    await db.webhookEndpoint.findUnique({ where: { id }, include })
  );
};

// True hard delete. Restricted by the ON DELETE RESTRICT FK on
// webhook_deliveries — the controller surfaces P2003 as a 409. Its
// subscriptions go with it.
export const remove = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  return withEventTypes(
    await db.webhookEndpoint.delete({ where: { id }, include })
  );
};

// The row is locked so concurrent rotations each keep the secret they replaced.
// A null `previousSecretExpiresAt` drops the replaced secret at once. The
// replaced secret moves as it is stored: both columns share one sealing name.
// Returns the plaintext new secret, for the one response that shows it.
// `plaintext` is the new secret when given, otherwise a fresh one.
export const rotateSecret = async (
  id: string,
  previousSecretExpiresAt: Date | null,
  tx: Prisma.TransactionClient,
  plaintext?: string
) => {
  const [current] = await tx.$queryRaw<{ signing_secret: string }[]>`
    SELECT "signing_secret" FROM "webhooks"."webhook_endpoints"
    WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (!current) throw new NotFoundError("Webhook endpoint not found");

  const secret = await newEndpointSecret(id, plaintext);
  const endpoint = withEventTypes(
    await tx.webhookEndpoint.update({
      where: { id },
      data: {
        signingSecret: secret.sealed,
        signingSecretHint: secret.hint,
        previousSigningSecret: previousSecretExpiresAt
          ? current.signing_secret
          : null,
        previousSecretExpiresAt,
      },
      include,
    })
  );
  return { endpoint, signingSecret: secret.plaintext };
};

export const revokePreviousSecret = async (
  id: string,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  return withEventTypes(
    await db.webhookEndpoint.update({
      where: { id },
      data: { previousSigningSecret: null, previousSecretExpiresAt: null },
      include,
    })
  );
};

export const resetConsecutiveFailures = async (
  id: string,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  // Conditional, so a successful delivery to a healthy endpoint writes nothing.
  await db.webhookEndpoint.updateMany({
    where: { id, consecutiveFailures: { gt: 0 } },
    data: { consecutiveFailures: 0 },
  });
};

export const incrementConsecutiveFailures = async (
  id: string,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  return await db.webhookEndpoint.update({
    where: { id },
    data: { consecutiveFailures: { increment: 1 } },
  });
};

/**
 * The organization's endpoints, and owned ones sent every organization's
 * events; with `recipientServiceIds`, only those these services own.
 */
export const findActiveByOrgAndEvent = async (
  organizationId: string,
  eventType: string,
  { recipientServiceIds }: { recipientServiceIds?: string[] } = {}
) => {
  const rows = await prisma.webhookEndpoint.findMany({
    where: {
      OR: [
        { organizationId },
        { organizationId: null, ownerServiceId: { not: null } },
      ],
      ...(recipientServiceIds && {
        ownerServiceId: { in: recipientServiceIds },
      }),
      status: "ACTIVE",
      archivedAt: null,
      subscriptions: { some: { eventType } },
    },
    include,
  });
  return rows.map(withEventTypes);
};
