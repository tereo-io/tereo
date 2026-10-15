import { assertNamespaceAvailable, namespacesOverlap } from "../registry.js";
import { disconnectTokenSockets } from "../../websocket/emitters/index.js";
import { deleteLoginClientTx, rotatedSecretFields } from "../clients.js";
import { getDefaultOrganizationId } from "../defaultOrganization.js";
import { computeChanges, emitTx, logAuditTx } from "../outbox.js";
import { approveProvisionedAccess } from "../serviceAccess.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma, type Prisma } from "../db/prisma.js";
import { formatClient } from "../transformers.js";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";
import db from "../db/index.js";
import env from "../../env.js";
import {
  createServiceTx,
  revokeServiceTokens,
  serviceAccountEmail,
  updateServiceTx,
} from "../services.js";
import {
  ProvisioningError,
  type ProvisionedClientSpec,
  type ProvisionedServiceSpec,
  type Provisioning,
} from "./load.js";

type Tx = Prisma.TransactionClient;

const PROVISIONING_LOCK = "provisioning";

export interface ProvisioningResult {
  created: string[];
  updated: string[];
  rotated: string[];
  unprovisioned: string[];
}

const SYSTEM_ACTOR = { userId: SYSTEM_USER_ID, email: null };

const GENERATE_SECRET = "npm run cli -- generate-secret";

const serviceLabel = (s: { slug: string }) => `services[${s.slug}]`;
const clientLabel = (c: { clientId: string }) => `clients[${c.clientId}]`;

const sortedUnique = (values: string[]) => [...new Set(values)].sort();

const accessOf = (spec: ProvisionedServiceSpec) => ({
  roles: sortedUnique(spec.access.roles),
  audiences: sortedUnique(spec.access.audiences),
});

const loadState = async (tx: Tx, p: Provisioning) => {
  const slugs = p.services.map((s) => s.slug);
  const clientIds = [
    ...p.services.map((s) => s.clientId),
    ...p.clients.map((c) => c.clientId),
  ];
  const hashes = [
    ...p.services.map((s) => s.secretHash),
    ...p.clients.flatMap((c) => (c.secretHash ? [c.secretHash] : [])),
  ];
  // One query at a time: a transaction runs on one connection.
  const services = await tx.service.findMany({
    where: { slug: { in: slugs } },
    include: { client: { include: { serviceAccountUser: true } } },
  });
  const clients = await tx.oAuthClient.findMany({
    where: { clientId: { in: clientIds } },
    include: { service: { select: { slug: true } } },
  });
  const allServices = await tx.service.findMany({ select: { slug: true } });
  const scopes = await tx.scope.findMany({
    where: { name: { in: p.clients.flatMap((c) => c.scopes) } },
    select: { name: true },
  });
  const secretHolders = await tx.oAuthClient.findMany({
    where: {
      OR: [
        { clientSecret: { in: hashes } },
        { previousSecretHash: { in: hashes } },
      ],
    },
    select: { id: true, clientSecret: true, previousSecretHash: true },
  });
  return {
    services: new Map(services.map((s) => [s.slug, s])),
    clients: new Map(clients.map((c) => [c.clientId, c])),
    serviceSlugs: new Set(allServices.map((s) => s.slug)),
    scopes: new Set(scopes.map((s) => s.name)),
    secretHolders,
  };
};

type State = Awaited<ReturnType<typeof loadState>>;

const findProblems = async (
  tx: Tx,
  p: Provisioning,
  state: State
): Promise<string[]> => {
  const problems: string[] = [];

  // The row each entry already owns, once it is known to be its own.
  const ownClientRow = new Map<string, string>();

  const checkSecret = (
    label: string,
    envName: string,
    hash: string,
    ownRowId: string | undefined
  ) => {
    for (const holder of state.secretHolders) {
      if (holder.id === ownRowId) {
        if (holder.clientSecret !== hash && holder.previousSecretHash === hash)
          problems.push(
            `${label}: ${envName} holds this entry's previous secret, which a rotation replaced; a rollback cannot bring it back. Generate a new one with ${GENERATE_SECRET} and set ${envName} to it`
          );
      } else if (
        holder.clientSecret === hash ||
        holder.previousSecretHash === hash
      ) {
        problems.push(
          `${label}: ${envName} is already the secret of another client; generate a new one with ${GENERATE_SECRET}`
        );
      }
    }
  };

  const newNamespaces: { label: string; namespace: string }[] = [];
  for (const spec of p.services) {
    const label = serviceLabel(spec);
    const existing = state.services.get(spec.slug);
    if (existing && !existing.provisioned) {
      problems.push(
        `${label}: a service with slug "${spec.slug}" already exists and was not created from the provisioning file`
      );
      continue;
    }
    if (existing) {
      if (existing.client?.clientId !== spec.clientId)
        problems.push(
          `${label}: clientId cannot change from "${existing.client?.clientId}"`
        );
      if (existing.namespace !== spec.namespace)
        problems.push(
          `${label}: namespace cannot change from "${existing.namespace}"`
        );
      if (existing.client) ownClientRow.set(label, existing.client.id);
    } else {
      try {
        await assertNamespaceAvailable(spec.namespace, tx);
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        problems.push(`${label}: ${err.message}`);
      }
      for (const other of newNamespaces)
        if (namespacesOverlap(spec.namespace, other.namespace))
          problems.push(
            `${label}: namespace "${spec.namespace}" overlaps "${other.namespace}" of ${other.label}`
          );
      newNamespaces.push({ label, namespace: spec.namespace });
      const email = serviceAccountEmail(spec.slug);
      if (await tx.user.findUnique({ where: { email } }))
        problems.push(`${label}: a user with email "${email}" already exists`);
    }

    const client = state.clients.get(spec.clientId);
    if (client && client.id !== existing?.client?.id)
      problems.push(
        client.provisioned
          ? `${label}: clientId "${spec.clientId}" is already used by another client`
          : `${label}: a client with clientId "${spec.clientId}" already exists and was not created from the provisioning file`
      );

    checkSecret(
      label,
      spec.secretEnv,
      spec.secretHash,
      ownClientRow.get(label)
    );
  }

  const fileSlugs = new Set(p.services.map((s) => s.slug));
  for (const spec of p.clients) {
    const label = clientLabel(spec);
    const existing = state.clients.get(spec.clientId);
    if (existing && !existing.provisioned) {
      problems.push(
        `${label}: a client with clientId "${spec.clientId}" already exists and was not created from the provisioning file`
      );
      continue;
    }
    if (existing?.service) {
      problems.push(
        `${label}: clientId "${spec.clientId}" is the client of service "${existing.service.slug}"`
      );
      continue;
    }

    for (const scope of sortedUnique(spec.scopes))
      if (!state.scopes.has(scope))
        problems.push(`${label}: scope "${scope}" is not registered`);

    // Services this file creates may be named before they exist.
    for (const slug of sortedUnique(spec.audience))
      if (!state.serviceSlugs.has(slug) && !fileSlugs.has(slug))
        problems.push(`${label}: audience "${slug}" is not a service`);

    if (spec.secretEnv && spec.secretHash)
      checkSecret(label, spec.secretEnv, spec.secretHash, existing?.id);
  }

  return problems;
};

const rotateSecret = async (
  tx: Tx,
  client: { id: string; clientSecret: string | null },
  hash: string,
  now: Date
) => {
  const data = rotatedSecretFields(client.clientSecret, hash, now);
  await tx.oAuthClient.update({ where: { id: client.id }, data });
  return data.previousSecretExpiresAt;
};

const serviceRows = <
  C extends { serviceAccountUser: { id: string } | null },
>(service: {
  slug: string;
  client: C | null;
}) => {
  const client = service.client;
  const accountUser = client?.serviceAccountUser;
  if (!client || !accountUser)
    throw new Error(
      `Service ${service.slug} has no client or service account; its rows are inconsistent`
    );
  return { client, accountUserId: accountUser.id };
};

const applyService = async (
  tx: Tx,
  spec: ProvisionedServiceSpec,
  state: State,
  now: Date,
  result: ProvisioningResult
) => {
  const entry = `service:${spec.slug}`;
  const access = accessOf(spec);
  const existing = state.services.get(spec.slug);
  if (!existing) {
    await createServiceTx(
      tx,
      {
        slug: spec.slug,
        name: spec.name,
        namespace: spec.namespace,
        clientId: spec.clientId,
        clientSecretHash: spec.secretHash,
        provisioned: true,
        provisionedAccess: access,
      },
      SYSTEM_ACTOR
    );
    result.created.push(entry);
    return;
  }

  const changes = computeChanges(
    {
      name: existing.name,
      provisionedAccess: existing.provisionedAccess,
      unprovisionedAt: existing.unprovisionedAt,
    },
    { name: spec.name, provisionedAccess: access, unprovisionedAt: null }
  );
  if (changes) {
    await tx.service.update({
      where: { id: existing.id },
      data: {
        name: spec.name,
        provisionedAccess: access,
        unprovisionedAt: null,
      },
    });
    if (existing.client && existing.client.name !== spec.name)
      await tx.oAuthClient.update({
        where: { id: existing.client.id },
        data: { name: spec.name },
      });
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      action: "UPDATE",
      entityType: "Service",
      entityId: existing.id,
      entityName: existing.slug,
      changes,
      metadata: { action: "provisioned" },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "core.service.updated",
      entityType: "Service",
      entityId: existing.id,
      data: {
        id: existing.id,
        slug: existing.slug,
        name: spec.name,
        isActive: existing.isActive,
      },
    });
    result.updated.push(entry);
  }

  const { client, accountUserId } = serviceRows(existing);

  if (!existing.isActive) {
    await updateServiceTx(
      tx,
      {
        id: existing.id,
        name: spec.name,
        isActive: false,
        client,
        accountUserId,
      },
      { isActive: true },
      SYSTEM_ACTOR
    );
    result.updated.push(entry);
  }

  if (client.clientSecret !== spec.secretHash) {
    const previousSecretExpiresAt = await rotateSecret(
      tx,
      client,
      spec.secretHash,
      now
    );
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      action: "UPDATE",
      entityType: "Service",
      entityId: existing.id,
      entityName: existing.slug,
      metadata: { action: "secret_rotated", previousSecretExpiresAt },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "core.service.secret-regenerated",
      entityType: "Service",
      entityId: existing.id,
      data: { id: existing.id, slug: existing.slug, previousSecretExpiresAt },
    });
    result.rotated.push(entry);
  }
};

/** What a login client's row holds for its entry, the secret aside. */
const clientFields = (spec: ProvisionedClientSpec) => ({
  name: spec.name,
  clientType: spec.clientType,
  redirectUris: spec.redirectUris,
  postLogoutRedirectUris: spec.postLogoutRedirectUris,
  scopes: spec.scopes,
  grantTypes: spec.grantTypes,
  audience: sortedUnique(spec.audience),
  consentRequired: spec.consentRequired,
});

const applyClient = async (
  tx: Tx,
  spec: ProvisionedClientSpec,
  state: State,
  now: Date,
  result: ProvisioningResult
) => {
  const entry = `client:${spec.clientId}`;
  const fields = clientFields(spec);
  const existing = state.clients.get(spec.clientId);
  if (!existing) {
    const client = await db.clients.create(
      {
        ...fields,
        clientId: spec.clientId,
        clientSecret: spec.secretHash,
        ownerId: SYSTEM_USER_ID,
        provisioned: true,
      },
      tx
    );
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      action: "CREATE",
      entityType: "OAuthClient",
      entityId: client.id,
      entityName: client.name,
      metadata: {
        clientId: client.clientId,
        clientType: client.clientType,
        grantTypes: client.grantTypes,
        scopes: client.scopes,
        audience: client.audience,
        provisioned: true,
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.client.created",
      entityType: "OAuthClient",
      entityId: client.id,
      data: formatClient(client) as Record<string, unknown>,
    });
    result.created.push(entry);
    return;
  }

  // A secret appears or goes with the client type; a changed one rotates.
  const rotates =
    !!spec.secretHash &&
    !!existing.clientSecret &&
    spec.secretHash !== existing.clientSecret;
  const secretChange =
    !rotates && spec.secretHash !== existing.clientSecret
      ? spec.secretHash
        ? "secret_set"
        : "secret_removed"
      : null;

  const changes = computeChanges(
    {
      ...Object.fromEntries(
        Object.keys(fields).map((key) => [
          key,
          existing[key as keyof typeof fields],
        ])
      ),
      unprovisionedAt: existing.unprovisionedAt,
    },
    { ...fields, unprovisionedAt: null }
  );
  if (changes || secretChange) {
    const updated = await tx.oAuthClient.update({
      where: { id: existing.id },
      data: {
        ...fields,
        unprovisionedAt: null,
        ...(secretChange && {
          clientSecret: spec.secretHash,
          previousSecretHash: null,
          previousSecretExpiresAt: null,
        }),
      },
    });
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      action: "UPDATE",
      entityType: "OAuthClient",
      entityId: existing.id,
      entityName: updated.name,
      changes,
      metadata: {
        action: "provisioned",
        ...(secretChange && { secret: secretChange }),
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.client.updated",
      entityType: "OAuthClient",
      entityId: existing.id,
      data: formatClient(updated) as Record<string, unknown>,
    });
    result.updated.push(entry);
  }

  if (rotates) {
    const previousSecretExpiresAt = await rotateSecret(
      tx,
      existing,
      spec.secretHash!,
      now
    );
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      action: "UPDATE",
      entityType: "OAuthClient",
      entityId: existing.id,
      entityName: spec.name,
      metadata: {
        clientId: existing.clientId,
        action: "secret_rotated",
        previousSecretExpiresAt,
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.client.secret-regenerated",
      entityType: "OAuthClient",
      entityId: existing.id,
      data: { id: existing.id, clientId: existing.clientId, name: spec.name },
    });
    result.rotated.push(entry);
  }
};

const markMissing = async (
  tx: Tx,
  p: Provisioning,
  now: Date,
  result: ProvisioningResult
) => {
  const services = await tx.service.findMany({
    where: {
      provisioned: true,
      unprovisionedAt: null,
      slug: { notIn: p.services.map((s) => s.slug) },
    },
  });
  for (const service of services) {
    await tx.service.update({
      where: { id: service.id },
      data: { unprovisionedAt: now },
    });
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      action: "UPDATE",
      entityType: "Service",
      entityId: service.id,
      entityName: service.slug,
      changes: { unprovisionedAt: { old: null, new: now } },
      metadata: { action: "unprovisioned" },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "core.service.updated",
      entityType: "Service",
      entityId: service.id,
      data: {
        id: service.id,
        slug: service.slug,
        name: service.name,
        isActive: service.isActive,
      },
    });
    result.unprovisioned.push(`service:${service.slug}`);
  }

  const clients = await tx.oAuthClient.findMany({
    where: {
      provisioned: true,
      unprovisionedAt: null,
      service: { is: null },
      clientId: { notIn: p.clients.map((c) => c.clientId) },
    },
  });
  for (const client of clients) {
    const updated = await tx.oAuthClient.update({
      where: { id: client.id },
      data: { unprovisionedAt: now },
    });
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      action: "UPDATE",
      entityType: "OAuthClient",
      entityId: client.id,
      entityName: client.name,
      changes: { unprovisionedAt: { old: null, new: now } },
      metadata: { action: "unprovisioned", clientId: client.clientId },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.client.updated",
      entityType: "OAuthClient",
      entityId: client.id,
      data: formatClient(updated) as Record<string, unknown>,
    });
    result.unprovisioned.push(`client:${client.clientId}`);
  }
};

/**
 * Bring the database in line with the provisioning file, all or nothing:
 * every problem is reported before anything is written. Serialized, so
 * replicas starting together apply it once.
 */
export const applyProvisioning = async (
  p: Provisioning,
  now: Date = new Date()
): Promise<ProvisioningResult> => {
  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${PROVISIONING_LOCK}, 0))`;
      const state = await loadState(tx, p);
      const problems = await findProblems(tx, p, state);
      if (problems.length > 0) throw new ProvisioningError(problems);

      const result: ProvisioningResult = {
        created: [],
        updated: [],
        rotated: [],
        unprovisioned: [],
      };
      for (const spec of p.services)
        await applyService(tx, spec, state, now, result);
      for (const spec of p.clients)
        await applyClient(tx, spec, state, now, result);
      await markMissing(tx, p, now, result);
      return result;
    },
    { timeout: 30_000 }
  );
  // Requests registered before the file listed them.
  const services = await prisma.service.findMany({
    where: { slug: { in: p.services.map((s) => s.slug) } },
    select: { id: true },
  });
  for (const service of services) await approveProvisionedAccess(service.id);
  return result;
};

// `now` is a parameter for tests.
export const deprovisionMissing = async (
  now: Date = new Date()
): Promise<{ services: number; clients: number }> => {
  const cutoff = new Date(
    now.getTime() - env.REGISTRY_RETIREMENT_GRACE_HOURS * 60 * 60 * 1000
  );
  const { serviceClientIds, jtis, services, clients } =
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${PROVISIONING_LOCK}, 0))`;
        const stale = { provisioned: true, unprovisionedAt: { lte: cutoff } };
        const dueServices = await tx.service.findMany({
          where: { ...stale, isActive: true },
          include: { client: { include: { serviceAccountUser: true } } },
        });
        const serviceClientIds: string[] = [];
        for (const service of dueServices) {
          const { client, accountUserId } = serviceRows(service);
          await updateServiceTx(
            tx,
            {
              id: service.id,
              name: service.name,
              isActive: true,
              client,
              accountUserId,
            },
            { isActive: false },
            SYSTEM_ACTOR
          );
          serviceClientIds.push(client.id);
        }

        const dueClients = await tx.oAuthClient.findMany({
          where: { ...stale, service: { is: null } },
        });
        const jtis: string[] = [];
        for (const client of dueClients)
          jtis.push(...(await deleteLoginClientTx(tx, client, SYSTEM_ACTOR)));
        return {
          serviceClientIds,
          jtis,
          services: dueServices.length,
          clients: dueClients.length,
        };
      },
      { timeout: 30_000 }
    );
  for (const id of serviceClientIds) await revokeServiceTokens(id);
  disconnectTokenSockets(jtis);
  if (services > 0 || clients > 0)
    logger.info(
      { services, clients },
      "Retired entries removed from the provisioning file"
    );
  return { services, clients };
};
