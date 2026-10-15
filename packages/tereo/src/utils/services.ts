import { getDefaultOrganizationId } from "./defaultOrganization.js";
import { UserType } from "../../prisma/generated/client/index.js";
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
  provisionedAccess?: { roles: string[]; audiences: string[] };
}

export const serviceAccountEmail = (slug: string) =>
  `${slug}@services.tereo.internal`;

export const createServiceTx = async (
  tx: Prisma.TransactionClient,
  input: CreateServiceInput,
  actor: { userId: string; email: string | null }
) => {
  const { slug, name, namespace } = input;
  if (await tx.service.findUnique({ where: { slug } })) {
    throw new ConflictError(`A service with slug "${slug}" already exists`);
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
      provisionedAccess: input.provisionedAccess,
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
  actor: { userId: string; email: string | null }
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
    },
  });
  return after;
};
