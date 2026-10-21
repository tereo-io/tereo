import { getDefaultOrganizationId } from "./defaultOrganization.js";
import { UserType } from "../../prisma/generated/client/index.js";
import { CORE_RESERVED_SLUGS } from "../definitions/index.js";
import { assertNamespaceAvailable } from "./registry.js";
import { emitTx, logAuditTx } from "./outbox.js";
import type { Prisma } from "./db/prisma.js";
import { ConflictError } from "./errors.js";
import db from "./db/index.js";

export interface CreateServiceInput {
  slug: string;
  name: string;
  namespace: string;
  clientId: string;
  clientSecretHash: string;
  provisioned?: boolean;
  internalHost?: string | null;
  /** Added to the audit entry's metadata. */
  auditMetadata?: Record<string, unknown>;
}

/** A slug from a display name: lowercase words joined by hyphens. */
export const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    // slug and namespace are VarChar(64).
    .slice(0, 64)
    .replace(/-+$/, "");

export const serviceAccountEmail = (slug: string) =>
  `${slug}@services.tereo.internal`;

/** Throws for a slug no service or integration may take (`CORE_RESERVED_SLUGS`). */
export const assertSlugUnreserved = (slug: string) => {
  if (CORE_RESERVED_SLUGS.includes(slug)) {
    throw new ConflictError(`Slug "${slug}" is reserved for core`);
  }
};

export const createServiceTx = async (
  tx: Prisma.TransactionClient,
  input: CreateServiceInput,
  actor: { userId: string; email: string | null }
) => {
  const { slug, name, namespace } = input;
  assertSlugUnreserved(slug);
  if (await tx.service.findUnique({ where: { slug } })) {
    throw new ConflictError(
      `A service with slug "${slug}" already exists`,
      "slug_taken"
    );
  }
  await assertNamespaceAvailable(namespace, tx);
  const email = serviceAccountEmail(slug);
  if (await tx.user.findUnique({ where: { email } })) {
    throw new ConflictError(`A user with email "${email}" already exists`);
  }

  const client = await tx.oAuthClient.create({
    data: {
      clientId: input.clientId,
      clientSecret: input.clientSecretHash,
      clientType: "confidential",
      name,
      redirectUris: [],
      scopes: [],
      grantTypes: ["client_credentials"],
      audience: [],
      ownerId: actor.userId,
      provisioned: input.provisioned,
    },
  });
  await tx.user.create({
    data: {
      email,
      name,
      passwordHash: "!",
      userType: UserType.service_account,
      oauthClientId: client.id,
    },
  });
  const created = await tx.service.create({
    data: {
      slug,
      name,
      namespace,
      clientId: client.id,
      createdBy: actor.userId,
      provisioned: input.provisioned,
      internalHost: input.internalHost ?? null,
    },
  });

  await logAuditTx(tx, {
    auth: actor,
    action: "CREATE",
    entityType: "Service",
    entityId: created.id,
    entityName: slug,
    metadata: {
      name,
      namespace,
      clientId: input.clientId,
      ...(input.provisioned && { provisioned: true }),
      ...input.auditMetadata,
    },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "core.service.created",
    entityType: "Service",
    entityId: created.id,
    data: { id: created.id, slug, name, namespace },
  });
  return db.services.get(created.id, tx);
};

export interface ServiceToUpdate {
  id: string;
  name: string;
  isActive: boolean;
  client: { id: string };
  accountUserId: string;
}

export const revokeServiceTokens = async (clientRowId: string) => {
  await db.accessTokens.revokeByClientId(clientRowId);
};

// The caller revokes the tokens of a service it deactivated.
export const updateServiceTx = async (
  tx: Prisma.TransactionClient,
  existing: ServiceToUpdate,
  body: { name?: string; isActive?: boolean },
  actor: { userId: string; email: string | null },
  auditMetadata?: Record<string, unknown>
) => {
  await tx.service.update({
    where: { id: existing.id },
    data: { name: body.name, isActive: body.isActive },
  });
  if (body.isActive !== undefined) {
    await tx.user.update({
      where: { id: existing.accountUserId },
      data: { isActive: body.isActive },
    });
  }
  if (body.name !== undefined) {
    await tx.oAuthClient.update({
      where: { id: existing.client.id },
      data: { name: body.name },
    });
  }
  const after = await db.services.get(existing.id, tx);
  await logAuditTx(tx, {
    auth: actor,
    action: "UPDATE",
    entityType: "Service",
    entityId: after.id,
    entityName: after.slug,
    changes: {
      ...(body.name !== undefined && {
        name: { old: existing.name, new: after.name },
      }),
      ...(body.isActive !== undefined && {
        isActive: { old: existing.isActive, new: after.isActive },
      }),
    },
    ...(auditMetadata && { metadata: auditMetadata }),
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "core.service.updated",
    entityType: "Service",
    entityId: after.id,
    data: {
      id: after.id,
      slug: after.slug,
      name: after.name,
      isActive: after.isActive,
      unprovisionedAt: after.unprovisionedAt?.toISOString() ?? null,
    },
  });
  return after;
};
