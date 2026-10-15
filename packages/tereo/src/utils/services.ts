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

/** The email of a service's service-account user. */
export const serviceAccountEmail = (slug: string) =>
  `${slug}@services.tereo.internal`;

/**
 * Add a service: its confidential client (client_credentials only), the
 * service-account user it acts as, and its row, audited and announced.
 */
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
