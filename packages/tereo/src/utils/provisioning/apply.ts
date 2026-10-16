import { deleteLoginClientTx, rotatedSecretFields } from "../clients.js";
import { getDefaultOrganizationId } from "../defaultOrganization.js";
import { computeChanges, emitTx, logAuditTx } from "../outbox.js";
import { formatClient, formatRole } from "../transformers.js";
import { syncProvisionedAccessTx } from "../serviceAccess.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma, type Prisma } from "../db/prisma.js";
import type { CustomRoleEntry } from "./schema.js";
import { validateSet } from "./validate.js";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";
import db from "../db/index.js";
import env from "../../env.js";
import {
  disconnectTokenSockets,
  notifyRoleDeleted,
  notifyRolePermissionsChanged,
  notifyRoleStatusChanged,
} from "../../websocket/emitters/index.js";
import {
  createServiceTx,
  revokeServiceTokens,
  serviceAccountEmail,
  updateServiceTx,
} from "../services.js";
import {
  applyDeclarationTx,
  assertNamespaceAvailable,
  lockRegistries,
  type ParsedDeclaration,
} from "../registry.js";
import {
  ProvisioningError,
  type ProvisioningSet,
  type ResolvedClient,
  type ResolvedService,
} from "./load.js";

type Tx = Prisma.TransactionClient;

const PROVISIONING_LOCK = "provisioning";

export interface ProvisioningResult {
  created: string[];
  updated: string[];
  rotated: string[];
  unprovisioned: string[];
  /** Services whose declaration was applied. */
  declared: string[];
  /** Access granted, extended or revoked. */
  access: string[];
  /** Custom roles created or changed. */
  roles: string[];
}

/** An entry with the document it came from. */
interface FromDocument {
  file: string;
  version: string;
}
interface ServiceInSet extends FromDocument {
  service: ResolvedService;
}
interface ClientInSet extends FromDocument {
  client: ResolvedClient;
}
interface RoleInSet extends FromDocument {
  role: CustomRoleEntry;
}

const entriesOf = (set: ProvisioningSet) => ({
  services: set.documents.flatMap(({ file, version, service }) =>
    service ? [{ file, version, service }] : []
  ),
  clients: set.documents.flatMap(({ file, version, clients }) =>
    clients.map((client) => ({ file, version, client }))
  ),
  roles: set.documents.flatMap(({ file, version, roles }) =>
    roles.map((role) => ({ file, version, role }))
  ),
});

type Entries = ReturnType<typeof entriesOf>;

const documentMeta = ({ file, version }: FromDocument) => ({ file, version });

const SYSTEM_ACTOR = { userId: SYSTEM_USER_ID, email: null };

const GENERATE_SECRET = "npm run cli -- generate-secret";

const serviceLabel = ({ file, service }: ServiceInSet) =>
  `${file}: services[${service.slug}]`;
const clientLabel = ({ file, client }: ClientInSet) =>
  `${file}: clients[${client.clientId}]`;

const roleLabel = ({ file, role }: RoleInSet) => `${file}: roles[${role.name}]`;

const sortedUnique = (values: string[]) => [...new Set(values)].sort();

const loadState = async (tx: Tx, p: Entries) => {
  const services = p.services.map((e) => e.service);
  const clients = p.clients.map((e) => e.client);
  const slugs = services.map((s) => s.slug);
  const clientIds = [
    ...services.map((s) => s.clientId),
    ...clients.map((c) => c.clientId),
  ];
  const hashes = [
    ...services.map((s) => s.secretHash),
    ...clients.flatMap((c) => (c.secretHash ? [c.secretHash] : [])),
  ];
  // One query at a time: a transaction runs on one connection.
  const serviceRows = await tx.service.findMany({
    where: { slug: { in: slugs } },
    include: { client: { include: { serviceAccountUser: true } } },
  });
  const clientRows = await tx.oAuthClient.findMany({
    where: { clientId: { in: clientIds } },
    include: { service: { select: { slug: true } } },
  });
  const roleRows = await tx.role.findMany({
    where: { serviceId: null, name: { in: p.roles.map((e) => e.role.name) } },
    select: { name: true, provisioned: true },
  });
  const scopes = await tx.scope.findMany({
    where: { name: { in: clients.flatMap((c) => c.scopes) } },
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
    services: new Map(serviceRows.map((s) => [s.slug, s])),
    clients: new Map(clientRows.map((c) => [c.clientId, c])),
    roles: new Map(roleRows.map((r) => [r.name, r])),
    scopes: new Set(scopes.map((s) => s.name)),
    secretHolders,
  };
};

type State = Awaited<ReturnType<typeof loadState>>;

const findProblems = async (
  tx: Tx,
  p: Entries,
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

  for (const entry of p.services) {
    const spec = entry.service;
    const label = serviceLabel(entry);
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

  for (const entry of p.clients) {
    const spec = entry.client;
    const label = clientLabel(entry);
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

    if (spec.secretEnv && spec.secretHash)
      checkSecret(label, spec.secretEnv, spec.secretHash, existing?.id);
  }

  for (const entry of p.roles)
    if (state.roles.get(entry.role.name)?.provisioned === false)
      problems.push(
        `${roleLabel(entry)}: a role named "${entry.role.name}" already exists and was not created from the provisioning file`
      );

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
  from: ServiceInSet,
  state: State,
  now: Date,
  result: ProvisioningResult
) => {
  const spec = from.service;
  const meta = documentMeta(from);
  const entry = `service:${spec.slug}`;
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
        auditMetadata: meta,
      },
      SYSTEM_ACTOR
    );
    result.created.push(entry);
    return;
  }

  const changes = computeChanges(
    { name: existing.name, unprovisionedAt: existing.unprovisionedAt },
    { name: spec.name, unprovisionedAt: null }
  );
  if (changes) {
    await tx.service.update({
      where: { id: existing.id },
      data: { name: spec.name, unprovisionedAt: null },
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
      metadata: { action: "provisioned", ...meta },
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
      SYSTEM_ACTOR,
      { action: "provisioned", ...meta }
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
      metadata: { action: "secret_rotated", previousSecretExpiresAt, ...meta },
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
const clientFields = (spec: ResolvedClient) => ({
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
  from: ClientInSet,
  state: State,
  now: Date,
  result: ProvisioningResult
) => {
  const spec = from.client;
  const meta = documentMeta(from);
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
        ...meta,
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
        ...meta,
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
        ...meta,
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

/** What a custom role's row holds for its entry. */
const roleFields = (spec: CustomRoleEntry) => ({
  displayName: spec.displayName,
  description: spec.description ?? null,
});

/**
 * Creates or updates each custom role, its permission set replaced. Returns
 * the ids of roles whose permissions or activity changed, for the holders'
 * tokens and sessions once the transaction commits.
 */
const applyRoles = async (
  tx: Tx,
  p: Entries,
  result: ProvisioningResult
): Promise<{ permissionsChanged: string[]; statusChanged: string[] }> => {
  const permissionsChanged: string[] = [];
  const statusChanged: string[] = [];
  const permissions = await tx.permission.findMany({
    where: {
      name: { in: p.roles.flatMap((e) => e.role.permissions) },
      retiredAt: null,
    },
    select: { id: true, name: true },
  });
  const idOf = new Map(permissions.map((perm) => [perm.name, perm.id]));

  for (const from of p.roles) {
    const spec = from.role;
    const meta = documentMeta(from);
    const entry = `role:${spec.name}`;
    const wanted = sortedUnique(spec.permissions.map((n) => idOf.get(n)!));
    const fields = roleFields(spec);
    const existing = await tx.role.findFirst({
      where: { name: spec.name, serviceId: null },
      include: { rolePermissions: true },
    });

    if (!existing) {
      const created = await db.roles.create(
        {
          name: spec.name,
          displayName: spec.displayName,
          description: spec.description,
          provisioned: true,
        },
        tx
      );
      const role = await db.roles.setPermissions(created.id, wanted, tx);
      await logAuditTx(tx, {
        auth: SYSTEM_ACTOR,
        action: "CREATE",
        entityType: "Role",
        entityId: role.id,
        entityName: role.name,
        metadata: {
          displayName: role.displayName,
          provisioned: true,
          permissionIds: wanted,
          ...meta,
        },
      });
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "auth.role.created",
        entityType: "Role",
        entityId: role.id,
        data: formatRole(role) as Record<string, unknown>,
      });
      result.roles.push(entry);
      continue;
    }

    const held = sortedUnique(
      existing.rolePermissions.map((rp) => rp.permissionId)
    );
    const permissionsDiffer =
      held.length !== wanted.length || held.some((id, i) => id !== wanted[i]);
    const restored = existing.archivedAt !== null;
    const changes = computeChanges(
      {
        ...Object.fromEntries(
          Object.keys(fields).map((k) => [
            k,
            existing[k as keyof typeof fields],
          ])
        ),
        isActive: existing.isActive,
        archivedAt: existing.archivedAt,
        unprovisionedAt: existing.unprovisionedAt,
      },
      {
        ...fields,
        isActive: restored ? true : existing.isActive,
        archivedAt: null,
        unprovisionedAt: null,
      }
    );
    if (!changes && !permissionsDiffer) continue;

    await tx.role.update({
      where: { id: existing.id },
      data: {
        ...fields,
        archivedAt: null,
        unprovisionedAt: null,
        ...(restored && { isActive: true }),
      },
    });
    if (permissionsDiffer)
      await db.roles.setPermissions(existing.id, wanted, tx);
    const role = await db.roles.get(existing.id, tx);
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      action: "UPDATE",
      entityType: "Role",
      entityId: role.id,
      entityName: role.name,
      changes,
      metadata: {
        action: "provisioned",
        ...(permissionsDiffer && { permissionIds: wanted }),
        ...meta,
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: restored ? "auth.role.restored" : "auth.role.updated",
      entityType: "Role",
      entityId: role.id,
      data: formatRole(role) as Record<string, unknown>,
    });
    if (permissionsDiffer) {
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "auth.role.permissions-changed",
        entityType: "Role",
        entityId: role.id,
        data: { id: role.id, name: role.name, permissionIds: wanted },
      });
      permissionsChanged.push(role.id);
    }
    if (restored) statusChanged.push(role.id);
    result.roles.push(entry);
  }
  return { permissionsChanged, statusChanged };
};

const markMissing = async (
  tx: Tx,
  p: Entries,
  now: Date,
  result: ProvisioningResult
) => {
  const services = await tx.service.findMany({
    where: {
      provisioned: true,
      unprovisionedAt: null,
      slug: { notIn: p.services.map((e) => e.service.slug) },
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
      clientId: { notIn: p.clients.map((e) => e.client.clientId) },
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

  const roles = await tx.role.findMany({
    where: {
      provisioned: true,
      unprovisionedAt: null,
      serviceId: null,
      name: { notIn: p.roles.map((e) => e.role.name) },
    },
  });
  for (const role of roles) {
    await tx.role.update({
      where: { id: role.id },
      data: { unprovisionedAt: now },
    });
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      action: "UPDATE",
      entityType: "Role",
      entityId: role.id,
      entityName: role.name,
      changes: { unprovisionedAt: { old: null, new: now } },
      metadata: { action: "unprovisioned" },
    });
    result.unprovisioned.push(`role:${role.name}`);
  }
};

const declarationOf = (
  version: string,
  service: ResolvedService
): ParsedDeclaration => ({
  version,
  permissions: service.permissions,
  systemRoles: service.systemRoles,
  buckets: service.buckets,
  eventTypes: service.eventTypes,
  requestedAccess: { roles: [], audiences: [] },
});

/** Runs `write`, turning a refusal it throws into a problem of `label`. */
const asProblem = async (
  label: string,
  problems: string[],
  write: () => Promise<void>
) => {
  try {
    await write();
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    problems.push(`${label}: ${err.message}`);
  }
};

/** Declarations, then access, which may name roles the declarations add. */
const applyServicesContent = async (
  tx: Tx,
  p: Entries,
  now: Date,
  result: ProvisioningResult
): Promise<{ problems: string[]; revokedClients: string[] }> => {
  const rows = new Map(
    (
      await tx.service.findMany({
        where: { slug: { in: p.services.map((e) => e.service.slug) } },
        include: { client: { include: { serviceAccountUser: true } } },
      })
    ).map((row) => [row.slug, row])
  );
  const problems: string[] = [];

  for (const entry of p.services) {
    const row = rows.get(entry.service.slug)!;
    await asProblem(serviceLabel(entry), problems, async () => {
      const { changed } = await applyDeclarationTx(
        tx,
        row,
        declarationOf(entry.version, entry.service),
        SYSTEM_ACTOR,
        now,
        documentMeta(entry)
      );
      if (changed) result.declared.push(`service:${row.slug}`);
    });
  }
  const revokedClients: string[] = [];
  if (problems.length > 0) return { problems, revokedClients };

  for (const entry of p.services) {
    const row = rows.get(entry.service.slug)!;
    const { client, accountUserId } = serviceRows(row);
    await asProblem(serviceLabel(entry), problems, async () => {
      const changes = await syncProvisionedAccessTx(
        tx,
        { id: row.id, slug: row.slug, accountUserId, client },
        {
          roles: sortedUnique(entry.service.access.roles),
          audiences: sortedUnique(entry.service.access.audiences),
        },
        now,
        documentMeta(entry)
      );
      for (const [verb, keys] of Object.entries(changes))
        for (const key of keys)
          result.access.push(`service:${row.slug} ${verb} ${key}`);
      if (changes.revoked.length > 0) revokedClients.push(client.id);
    });
  }
  return { problems, revokedClients };
};

/**
 * Bring the database in line with the provisioning set, all or nothing:
 * every problem is reported before anything is written. Serialized, so
 * replicas starting together apply it once.
 */
export const applyProvisioning = async (
  set: ProvisioningSet,
  now: Date = new Date()
): Promise<ProvisioningResult> => {
  const invalid = validateSet(set);
  if (invalid.length > 0) throw new ProvisioningError(invalid);
  const p = entriesOf(set);

  const { result, revokedClients, roleChanges } = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${PROVISIONING_LOCK}, 0))`;
      const state = await loadState(tx, p);
      // Before any row is written: the registry route and admin decisions
      // take these first, then rows.
      await lockRegistries(
        tx,
        [...state.services.values()].map((s) => s.id)
      );
      const problems = await findProblems(tx, p, state);
      if (problems.length > 0) throw new ProvisioningError(problems);

      const result: ProvisioningResult = {
        created: [],
        updated: [],
        rotated: [],
        unprovisioned: [],
        declared: [],
        access: [],
        roles: [],
      };
      for (const entry of p.services)
        await applyService(tx, entry, state, now, result);
      const content = await applyServicesContent(tx, p, now, result);
      if (content.problems.length > 0)
        throw new ProvisioningError(content.problems);
      const roleChanges = await applyRoles(tx, p, result);
      for (const entry of p.clients)
        await applyClient(tx, entry, state, now, result);
      await markMissing(tx, p, now, result);
      return { result, revokedClients: content.revokedClients, roleChanges };
    },
    { timeout: 120_000 }
  );
  // Their next token lacks what was revoked.
  for (const id of revokedClients) await revokeServiceTokens(id);
  for (const id of roleChanges.permissionsChanged) {
    await notifyRolePermissionsChanged(id);
    await revokeHolderClientTokens(id);
  }
  for (const id of roleChanges.statusChanged) await notifyRoleStatusChanged(id);
  return result;
};

/** A service client holding the role gets its next token with what it grants now. */
const revokeHolderClientTokens = async (roleId: string) => {
  const holders = await db.roles.getUserIdsByRoleId(roleId);
  const clientIds = new Set(
    holders.flatMap((h) => (h.user.oauthClientId ? [h.user.oauthClientId] : []))
  );
  for (const clientId of clientIds)
    await db.accessTokens.revokeByClientId(clientId);
};

// `now` is a parameter for tests.
export const deprovisionMissing = async (
  now: Date = new Date()
): Promise<{ services: number; clients: number; roles: number }> => {
  const cutoff = new Date(
    now.getTime() - env.REGISTRY_RETIREMENT_GRACE_HOURS * 60 * 60 * 1000
  );
  const { serviceClientIds, jtis, services, clients, archivedRoles } =
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

        const dueRoles = await tx.role.findMany({
          where: { ...stale, serviceId: null, archivedAt: null },
        });
        const archivedRoles: { id: string; name: string }[] = [];
        for (const role of dueRoles) {
          await tx.role.update({
            where: { id: role.id },
            data: { isActive: false, archivedAt: now },
          });
          await logAuditTx(tx, {
            auth: SYSTEM_ACTOR,
            action: "ARCHIVE",
            entityType: "Role",
            entityId: role.id,
            entityName: role.name,
            metadata: { action: "unprovisioned" },
          });
          await emitTx(tx, {
            organizationId: getDefaultOrganizationId(),
            eventType: "auth.role.archived",
            entityType: "Role",
            entityId: role.id,
            data: { id: role.id, name: role.name },
          });
          archivedRoles.push({ id: role.id, name: role.name });
        }
        return {
          serviceClientIds,
          jtis,
          services: dueServices.length,
          clients: dueClients.length,
          archivedRoles,
        };
      },
      { timeout: 30_000 }
    );
  for (const id of serviceClientIds) await revokeServiceTokens(id);
  disconnectTokenSockets(jtis);
  for (const { id } of archivedRoles) {
    await revokeHolderClientTokens(id);
    notifyRoleDeleted(
      (await db.roles.getUserIdsByRoleId(id)).map((h) => h.userId)
    );
  }
  const roles = archivedRoles.length;
  if (services > 0 || clients > 0 || roles > 0)
    logger.info(
      { services, clients, roles },
      "Retired entries removed from the provisioning file"
    );
  return { services, clients, roles };
};
