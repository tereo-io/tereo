import { getDefaultOrganizationId } from "../defaultOrganization.js";
import { computeChanges, emitTx, logAuditTx } from "../outbox.js";
import { broadcastBucketInvalidate } from "../cacheBroadcast.js";
import { formatClient, formatRole } from "../transformers.js";
import { syncProvisionedAccessTx } from "../serviceAccess.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { invalidateBranding } from "../branding/resolve.js";
import { invalidateAfterWrite } from "../branding/write.js";
import { setRateLimitTx } from "../rateLimitOverride.js";
import { openSigningSecret } from "../webhookSecrets.js";
import { AppError, ConflictError } from "../errors.js";
import { prisma, type Prisma } from "../db/prisma.js";
import { assertAdminRemains } from "../adminGuard.js";
import { resolveProvisionedRole } from "./roles.js";
import type { CustomRoleEntry } from "./schema.js";
import { afterGroupChange } from "../groups.js";
import { validateSet } from "./validate.js";
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
  emitEndpointEventTx,
  redactWebhookUrl,
} from "../webhookEndpointEvents.js";
import {
  applyBranding,
  brandingClientProblems,
  storeProvisionedImages,
} from "./brandingApply.js";
import {
  createIntegrationTx,
  emitIntegration,
  integrationRef,
  setIntegrationAudiencesTx,
  setIntegrationRolesTx,
  updateIntegrationTx,
} from "../integrations.js";
import {
  applyGroups,
  archiveDueGroups,
  groupProblems,
  markGroupsMissing,
} from "./groupsApply.js";
import {
  GUEST_DEFAULT_ROLES_KEY,
  getGuestDefaultRoleIds,
} from "../guestRoles.js";
import {
  createServiceTx,
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
  deleteLoginClientTx,
  rotatedSecretFields,
  withRetired,
} from "../clients.js";
import {
  ProvisioningError,
  type ProvisioningSet,
  type ResolvedClient,
  type ResolvedIntegration,
  type ResolvedService,
  type ResolvedWebhook,
} from "./load.js";

type Tx = Prisma.TransactionClient;

const PROVISIONING_LOCK = "provisioning";

export interface ProvisioningResult {
  /**
   * Services, clients, integrations and webhooks (`webhook:<provisioning
   * key>`).
   */
  created: string[];
  updated: string[];
  rotated: string[];
  /** Webhooks here were archived; the rest retire after the grace. */
  unprovisioned: string[];
  /** Services whose declaration was applied. */
  declared: string[];
  /**
   * Access granted, extended or revoked; integrations' roles or audiences set;
   * a service account's rate limit changed.
   */
  access: string[];
  /** Custom roles created or changed. */
  roles: string[];
  /** Branding profiles (`default` or a client id) written or handed back. */
  branding: string[];
  /**
   * Groups (`group:<slug>`, `group:<organizationId>/<slug>`) created,
   * changed or brought back.
   */
  groups: string[];
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
interface IntegrationInSet extends FromDocument {
  integration: ResolvedIntegration;
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
  integrations: set.documents.flatMap(({ file, version, integrations }) =>
    (integrations ?? []).map((integration) => ({
      file,
      version,
      integration,
    }))
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
const integrationLabel = ({ file, integration }: IntegrationInSet) =>
  `${file}: integrations[${integration.slug}]`;

const sortedUnique = (values: string[]) => [...new Set(values)].sort();

const loadState = async (tx: Tx, p: Entries) => {
  const services = p.services.map((e) => e.service);
  const clients = p.clients.map((e) => e.client);
  const integrations = p.integrations.map((e) => e.integration);
  const slugs = [
    ...services.map((s) => s.slug),
    ...integrations.map((i) => i.slug),
  ];
  const clientIds = [
    ...services.map((s) => s.clientId),
    ...clients.map((c) => c.clientId),
    ...integrations.map((i) => i.clientId),
  ];
  const hashes = [
    ...services.map((s) => s.secretHash),
    ...clients.flatMap((c) => (c.secretHash ? [c.secretHash] : [])),
    ...integrations.map((i) => i.secretHash),
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
        { retiredSecretHashes: { hasSome: hashes } },
      ],
    },
    select: {
      id: true,
      clientSecret: true,
      previousSecretHash: true,
      retiredSecretHashes: true,
    },
  });
  return {
    // Integrations too: they share the table, and so the slugs.
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
      const retired = holder.retiredSecretHashes.includes(hash);
      if (holder.id === ownRowId) {
        if (holder.clientSecret === hash) continue;
        if (holder.previousSecretHash === hash)
          problems.push(
            `${label}: ${envName} holds this entry's previous secret, which a rotation replaced; a rollback cannot bring it back. Generate a new one with ${GENERATE_SECRET} and set ${envName} to it`
          );
        else if (retired)
          problems.push(
            `${label}: ${envName} holds a secret this entry used before, which was retired (rotated away, revoked or removed) and may have leaked; a rollback cannot bring it back. Generate a new one with ${GENERATE_SECRET} and set ${envName} to it`
          );
      } else if (
        holder.clientSecret === hash ||
        holder.previousSecretHash === hash
      ) {
        problems.push(
          `${label}: ${envName} is already the secret of another client; generate a new one with ${GENERATE_SECRET}`
        );
      } else if (retired) {
        problems.push(
          `${label}: ${envName} is a retired secret of another client and may have leaked; generate a new one with ${GENERATE_SECRET}`
        );
      }
    }
  };

  for (const entry of p.services) {
    const spec = entry.service;
    const label = serviceLabel(entry);
    const existing = state.services.get(spec.slug);
    if (existing?.kind === "integration") {
      problems.push(`${label}: slug "${spec.slug}" is an integration's`);
      continue;
    }
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

  const listed = p.services.flatMap((entry) =>
    entry.service.webhooks.flatMap((w) =>
      w.organizations === "all"
        ? []
        : w.organizations.map((id) => ({ entry, key: w.key, id }))
    )
  );
  const known = new Set(
    (
      await tx.organization.findMany({
        where: { id: { in: sortedUnique(listed.map((l) => l.id)) } },
        select: { id: true },
      })
    ).map((o) => o.id)
  );
  for (const { entry, key, id } of listed)
    if (!known.has(id))
      problems.push(
        `${serviceLabel(entry)}: webhooks[${key}]: no organization with id ${id}`
      );

  const integrationOrgs = sortedUnique(
    p.integrations.flatMap((e) =>
      e.integration.organizationId ? [e.integration.organizationId] : []
    )
  );
  const liveOrgs = new Set(
    (
      await tx.organization.findMany({
        where: { id: { in: integrationOrgs }, archivedAt: null },
        select: { id: true },
      })
    ).map((o) => o.id)
  );
  for (const entry of p.integrations) {
    const spec = entry.integration;
    const label = integrationLabel(entry);
    const existing = state.services.get(spec.slug);
    if (existing && existing.kind !== "integration") {
      problems.push(`${label}: slug "${spec.slug}" is a service's`);
      continue;
    }
    if (existing && !existing.provisioned) {
      problems.push(
        `${label}: an integration with slug "${spec.slug}" already exists and was not created from the provisioning file`
      );
      continue;
    }
    if (existing) {
      if (existing.client?.clientId !== spec.clientId)
        problems.push(
          `${label}: clientId cannot change from "${existing.client?.clientId}"`
        );
      if (existing.organizationId !== spec.organizationId)
        problems.push(
          `${label}: organizationId cannot change from ${existing.organizationId ?? "none"}`
        );
      if (existing.client) ownClientRow.set(label, existing.client.id);
    } else {
      if (spec.organizationId && !liveOrgs.has(spec.organizationId))
        problems.push(
          `${label}: no organization with id ${spec.organizationId}`
        );
      const email = serviceAccountEmail(spec.slug);
      if (await tx.user.findUnique({ where: { email } }))
        problems.push(`${label}: a user with email "${email}" already exists`);
    }

    const client = state.clients.get(spec.clientId);
    if (client && client.id !== existing?.client?.id)
      problems.push(
        `${label}: a client with clientId "${spec.clientId}" already exists`
      );

    checkSecret(
      label,
      spec.secretEnv,
      spec.secretHash,
      ownClientRow.get(label)
    );
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
  client: {
    id: string;
    clientSecret: string | null;
    previousSecretHash: string | null;
    retiredSecretHashes: string[];
  },
  hash: string,
  now: Date
) => {
  const data = rotatedSecretFields(client, hash, now);
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
        internalHost: spec.internalHost,
        auditMetadata: meta,
      },
      SYSTEM_ACTOR
    );
    result.created.push(entry);
    return;
  }

  const changes = computeChanges(
    {
      name: existing.name,
      internalHost: existing.internalHost,
      unprovisionedAt: existing.unprovisionedAt,
    },
    { name: spec.name, internalHost: spec.internalHost, unprovisionedAt: null }
  );
  if (changes) {
    await tx.service.update({
      where: { id: existing.id },
      data: {
        name: spec.name,
        internalHost: spec.internalHost,
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
        unprovisionedAt: null,
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

const applyIntegration = async (
  tx: Tx,
  from: IntegrationInSet,
  state: State,
  now: Date,
  result: ProvisioningResult
) => {
  const spec = from.integration;
  const meta = documentMeta(from);
  const entry = `integration:${spec.slug}`;
  const existing = state.services.get(spec.slug);
  if (!existing) {
    await createIntegrationTx(
      tx,
      {
        slug: spec.slug,
        name: spec.name,
        organizationId: spec.organizationId,
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

  const ref = integrationRef(await db.services.getIntegration(existing.id, tx));
  if (existing.unprovisionedAt) {
    await tx.service.update({
      where: { id: existing.id },
      data: { unprovisionedAt: null },
    });
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      action: "UPDATE",
      entityType: "Integration",
      entityId: existing.id,
      entityName: existing.slug,
      changes: {
        unprovisionedAt: { old: existing.unprovisionedAt, new: null },
      },
      metadata: { action: "provisioned", ...meta },
    });
    await emitIntegration(tx, "core.integration.updated", ref, {
      unprovisionedAt: null,
    });
  }
  if (existing.name !== spec.name || !existing.isActive) {
    await updateIntegrationTx(
      tx,
      ref,
      {
        ...(existing.name !== spec.name && { name: spec.name }),
        ...(!existing.isActive && { isActive: true }),
      },
      SYSTEM_ACTOR,
      { action: "provisioned", ...meta }
    );
  }
  if (
    existing.unprovisionedAt ||
    existing.name !== spec.name ||
    !existing.isActive
  )
    result.updated.push(entry);

  const client = existing.client!;
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
      entityType: "Integration",
      entityId: existing.id,
      entityName: existing.slug,
      metadata: { action: "secret_rotated", previousSecretExpiresAt, ...meta },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "core.integration.secret-regenerated",
      entityType: "Integration",
      entityId: existing.id,
      data: { id: existing.id, slug: existing.slug, previousSecretExpiresAt },
    });
    result.rotated.push(entry);
  }
};

/** Roles and audiences, once the roles and services they name exist. */
const applyIntegrationsAccess = async (
  tx: Tx,
  p: Entries,
  result: ProvisioningResult
): Promise<string[]> => {
  const problems: string[] = [];
  const setRoleNames = new Set(p.roles.map(({ role }) => role.name));
  for (const from of p.integrations) {
    const spec = from.integration;
    const label = integrationLabel(from);
    const meta = { action: "provisioned", ...documentMeta(from) };
    const row = await tx.service.findUniqueOrThrow({
      where: { slug: spec.slug },
      select: { id: true },
    });
    const ref = integrationRef(await db.services.getIntegration(row.id, tx));

    const roleIds: string[] = [];
    const missing: string[] = [];
    for (const name of sortedUnique(spec.roles)) {
      const role = await resolveProvisionedRole(tx, name, setRoleNames);
      if (role) roleIds.push(role.id);
      else missing.push(name);
    }
    if (missing.length > 0) {
      for (const name of missing)
        problems.push(
          `${label}: roles "${name}" does not exist in the database, or is archived or retired`
        );
      continue;
    }

    await asProblem(label, problems, async () => {
      if (await setIntegrationRolesTx(tx, ref, roleIds, SYSTEM_ACTOR, meta))
        result.access.push(`integration:${spec.slug} roles`);
      if (
        await setIntegrationAudiencesTx(
          tx,
          ref,
          spec.audiences,
          SYSTEM_ACTOR,
          meta
        )
      )
        result.access.push(`integration:${spec.slug} audiences`);
      if (
        await setRateLimitTx(
          tx,
          SYSTEM_ACTOR,
          ref.accountUserId,
          spec.rateLimitPerSecond ?? null
        )
      )
        result.access.push(`integration:${spec.slug} rate limit`);
    });
  }
  return problems;
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
  trustedCoreScopes: sortedUnique(spec.trustedCoreScopes),
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
          retiredSecretHashes: withRetired(
            existing.retiredSecretHashes,
            existing.clientSecret,
            existing.previousSecretHash
          ),
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
  requires2fa: spec.requires2fa,
  guestAssignable: spec.guestAssignable,
});

/**
 * Creates or updates each custom role, its permission set replaced. Returns
 * the ids of roles whose permissions or activity changed: the holders'
 * client tokens are revoked in the transaction, and their sessions told once
 * it commits.
 */
export const applyRoles = async (
  tx: Tx,
  roles: Entries["roles"],
  result: Pick<ProvisioningResult, "roles">
): Promise<{
  permissionsChanged: string[];
  statusChanged: string[];
  revokedJtis: string[];
}> => {
  const permissionsChanged: string[] = [];
  const statusChanged: string[] = [];
  const revokedJtis: string[] = [];
  const permissions = await tx.permission.findMany({
    where: {
      name: { in: roles.flatMap((e) => e.role.permissions) },
      retiredAt: null,
    },
    select: { id: true, name: true },
  });
  const idOf = new Map(permissions.map((perm) => [perm.name, perm.id]));
  const adminId = idOf.get("admin");
  const problems: string[] = [];

  // Before a role is written: the admin guard's lock comes before row locks.
  const losingAdmin = await tx.role.findMany({
    where: {
      serviceId: null,
      name: {
        in: roles
          .filter((e) => !e.role.permissions.includes("admin"))
          .map((e) => e.role.name),
      },
      isActive: true,
      archivedAt: null,
      rolePermissions: { some: { permission: { name: "admin" } } },
    },
    select: { name: true },
  });
  let hadAdmin = false;
  if (losingAdmin.length > 0) {
    await assertAdminRemains(null, tx);
    hadAdmin = await db.roles.adminExists(undefined, tx);
  }

  for (const from of roles) {
    const spec = from.role;
    const meta = documentMeta(from);
    const entry = `role:${spec.name}`;
    // Validation checked the names against the set and the code; the
    // database can still lack one (core's declaration not yet registered).
    const missing = spec.permissions.filter((n) => !idOf.has(n));
    if (missing.length > 0) {
      throw new ProvisioningError(
        missing.map(
          (n) =>
            `${roleLabel(from)}: permission "${n}" does not exist in the database`
        )
      );
    }
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
          requires2fa: spec.requires2fa,
          guestAssignable: spec.guestAssignable,
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
    const reactivated = restored || !existing.isActive;
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
        isActive: true,
        archivedAt: null,
        unprovisionedAt: null,
      }
    );
    if (!changes && !permissionsDiffer) continue;

    const grantedAdmin =
      !reactivated && adminId !== undefined && held.includes(adminId);
    if (spec.permissions.includes("admin") && !grantedAdmin) {
      // The lock an integration taking the role waits on (lockRoles).
      await db.roles.lockRoles([existing.id], "update", tx);
      const holders = await db.roles.integrationHolderSlugs(existing.id, tx);
      if (holders.length > 0) {
        problems.push(
          `${roleLabel(from)}: integrations can't hold a role carrying the admin permission, and this one is held by: ${holders.join(", ")}`
        );
        continue;
      }
    }

    await tx.role.update({
      where: { id: existing.id },
      data: {
        ...fields,
        archivedAt: null,
        unprovisionedAt: null,
        isActive: true,
      },
    });
    if (permissionsDiffer)
      await db.roles.setPermissions(existing.id, wanted, tx);
    const role = await db.roles.get(existing.id, tx);
    // Permissions are read live, so a guest's token from a password-only
    // login would keep working; revoked, its refresh meets the step-up.
    if (
      role.requires2fa &&
      role.guestAssignable &&
      !(existing.isActive && existing.requires2fa && existing.guestAssignable)
    ) {
      revokedJtis.push(
        ...(await db.accessTokens.revokeWithoutMfa(
          {
            userType: "guest",
            userRoles: {
              some: { roleId: role.id, organizationId: { not: null } },
            },
          },
          tx
        ))
      );
    }
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
    if (role.guestAssignable !== existing.guestAssignable) {
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "auth.role.guest-assignable-changed",
        entityType: "Role",
        entityId: role.id,
        data: {
          id: role.id,
          name: role.name,
          guestAssignable: role.guestAssignable,
        },
      });
    }
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
    if (reactivated) statusChanged.push(role.id);
    result.roles.push(entry);
  }
  // After the writes: another role of the set may have gained it.
  if (hadAdmin && !(await db.roles.adminExists(undefined, tx))) {
    const losing = new Set(losingAdmin.map((r) => r.name));
    for (const from of roles)
      if (losing.has(from.role.name))
        problems.push(
          `${roleLabel(from)}: taking the admin permission from this role would leave no active administrator; grant admin to another user first`
        );
  }
  if (problems.length > 0) throw new ProvisioningError(problems);
  return { permissionsChanged, statusChanged, revokedJtis };
};

/** Stores the roles new guests get by default, as ids; an absent section stores none. */
const applyGuests = async (tx: Tx, set: ProvisioningSet) => {
  const sources = set.documents.filter((d) => d.guests?.defaultRoles?.length);
  const meta = { files: sources.map((d) => d.file) };
  const names = set.documents.flatMap((d) => d.guests?.defaultRoles ?? []);
  const roles = await tx.role.findMany({
    where: { name: { in: names }, serviceId: null, archivedAt: null },
    select: { id: true, name: true },
  });
  const idOf = new Map(roles.map((r) => [r.name, r.id]));
  const next = names.map((n) => idOf.get(n)!);
  const previous = await getGuestDefaultRoleIds(tx);
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  await db.settings.set(GUEST_DEFAULT_ROLES_KEY, next, tx);
  // Audit only: `auth.settings.updated` carries the two-factor settings.
  await logAuditTx(tx, {
    auth: SYSTEM_ACTOR,
    action: "UPDATE",
    entityType: "SystemSettings",
    entityId: GUEST_DEFAULT_ROLES_KEY,
    entityName: "Guest default roles",
    metadata: {
      action: "provisioned",
      previousRoleIds: previous,
      roleIds: next,
      ...meta,
    },
  });
};

/** Where a webhook entry goes: one endpoint for all organizations, or one per listed one. */
const webhookTargets = (slug: string, w: ResolvedWebhook) =>
  w.organizations === "all"
    ? [{ provisioningKey: `${slug}:${w.key}`, organizationId: null }]
    : sortedUnique(w.organizations).map((organizationId) => ({
        provisioningKey: `${slug}:${w.key}:${organizationId}`,
        organizationId,
      }));

/**
 * Creates or updates each service's webhook endpoints, keyed by
 * `provisioningKey`, and archives at once those no longer in the set. Status
 * is left alone: an endpoint auto-disabled stays so until an admin re-enables
 * it.
 */
const applyWebhooks = async (
  tx: Tx,
  p: Entries,
  now: Date,
  result: ProvisioningResult
) => {
  const wanted: string[] = [];
  const overlapMs = env.WEBHOOK_SECRET_OVERLAP_HOURS * 60 * 60 * 1000;

  for (const from of p.services) {
    const meta = documentMeta(from);
    const row = await tx.service.findUniqueOrThrow({
      where: { slug: from.service.slug },
      include: { client: { include: { serviceAccountUser: true } } },
    });
    const { accountUserId } = serviceRows(row);

    for (const w of from.service.webhooks) {
      const events = sortedUnique(w.events);
      for (const { provisioningKey, organizationId } of webhookTargets(
        row.slug,
        w
      )) {
        wanted.push(provisioningKey);
        const entry = `webhook:${provisioningKey}`;
        const existing = await tx.webhookEndpoint.findUnique({
          where: { provisioningKey },
          include: { subscriptions: { select: { eventType: true } } },
        });

        if (!existing) {
          const { endpoint } = await db.webhookEndpoints.create(
            {
              organizationId,
              createdBy: accountUserId,
              ownerServiceId: row.id,
              provisioned: true,
              provisioningKey,
              url: w.url,
              description: w.description,
              eventTypes: events,
              signingSecret: w.secretPlain,
            },
            tx
          );
          await logAuditTx(tx, {
            auth: SYSTEM_ACTOR,
            organizationId,
            action: "CREATE",
            entityType: "WebhookEndpoint",
            entityId: endpoint.id,
            metadata: {
              url: redactWebhookUrl(w.url),
              eventTypes: events,
              provisioningKey,
              ...meta,
            },
          });
          await emitEndpointEventTx(tx, "created", endpoint);
          result.created.push(entry);
          continue;
        }

        // Opened before the row is written, and compared in the clear: the
        // stored value is sealed.
        const rotates = (await openSigningSecret(existing)) !== w.secretPlain;

        const held = sortedUnique(
          existing.subscriptions.map((s) => s.eventType)
        );
        const changes = computeChanges(
          {
            url: existing.url,
            description: existing.description,
            eventTypes: held,
          },
          { url: w.url, description: w.description, eventTypes: events }
        );
        const restored = existing.archivedAt !== null;
        if (changes || restored) {
          const written = await db.webhookEndpoints.update(
            existing.id,
            {
              url: w.url,
              description: w.description,
              ...(changes?.eventTypes && { eventTypes: events }),
            },
            tx
          );
          if (changes) {
            await emitEndpointEventTx(tx, "updated", written, {
              changedFields: Object.keys(changes),
            });
          }
          if (restored) {
            const back = await db.webhookEndpoints.restore(existing.id, tx);
            await emitEndpointEventTx(tx, "restored", back ?? written);
          }
          if (changes?.url) {
            changes.url = {
              old: redactWebhookUrl(String(changes.url.old)),
              new: redactWebhookUrl(String(changes.url.new)),
            };
          }
          await logAuditTx(tx, {
            auth: SYSTEM_ACTOR,
            organizationId,
            action: restored ? "RESTORE" : "UPDATE",
            entityType: "WebhookEndpoint",
            entityId: existing.id,
            changes,
            metadata: { action: "provisioned", provisioningKey, ...meta },
          });
          result.updated.push(entry);
        }

        if (rotates) {
          const previousSecretExpiresAt =
            overlapMs > 0 ? new Date(now.getTime() + overlapMs) : null;
          const rotated = await db.webhookEndpoints.rotateSecret(
            existing.id,
            previousSecretExpiresAt,
            tx,
            w.secretPlain
          );
          await emitEndpointEventTx(tx, "secret-rotated", rotated.endpoint, {
            previousSecretExpiresAt,
          });
          await logAuditTx(tx, {
            auth: SYSTEM_ACTOR,
            organizationId,
            action: "UPDATE",
            entityType: "WebhookEndpoint",
            entityId: existing.id,
            metadata: {
              action: "secret_rotated",
              previousSecretExpiresAt,
              provisioningKey,
              ...meta,
            },
          });
          result.rotated.push(entry);
        }
      }
    }
  }

  // No deliveries to a URL the deploy removed, so no grace.
  const dropped = await tx.webhookEndpoint.findMany({
    where: {
      provisioned: true,
      archivedAt: null,
      provisioningKey: { notIn: wanted },
    },
    select: {
      id: true,
      organizationId: true,
      provisioningKey: true,
      ownerService: { select: { slug: true } },
    },
  });
  // A service still in the set dropped the entry from its document.
  const documentOf = new Map(
    p.services.map((from) => [from.service.slug, documentMeta(from)])
  );
  for (const endpoint of dropped) {
    const owner = endpoint.ownerService?.slug;
    const archived = await db.webhookEndpoints.archive(endpoint.id, tx);
    if (archived) await emitEndpointEventTx(tx, "archived", archived);
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      organizationId: endpoint.organizationId,
      action: "ARCHIVE",
      entityType: "WebhookEndpoint",
      entityId: endpoint.id,
      metadata: {
        action: "unprovisioned",
        provisioningKey: endpoint.provisioningKey,
        ...(owner && documentOf.get(owner)),
      },
    });
    result.unprovisioned.push(`webhook:${endpoint.provisioningKey}`);
  }
};

const markMissing = async (
  tx: Tx,
  p: Entries,
  now: Date,
  result: ProvisioningResult
) => {
  const services = await tx.service.findMany({
    where: {
      kind: "service",
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
        unprovisionedAt: now.toISOString(),
      },
    });
    result.unprovisioned.push(`service:${service.slug}`);
  }

  const integrations = await tx.service.findMany({
    where: {
      kind: "integration",
      provisioned: true,
      unprovisionedAt: null,
      slug: { notIn: p.integrations.map((e) => e.integration.slug) },
    },
  });
  for (const integration of integrations) {
    await tx.service.update({
      where: { id: integration.id },
      data: { unprovisionedAt: now },
    });
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      action: "UPDATE",
      entityType: "Integration",
      entityId: integration.id,
      entityName: integration.slug,
      changes: { unprovisionedAt: { old: null, new: now } },
      metadata: { action: "unprovisioned" },
    });
    await emitIntegration(tx, "core.integration.updated", integration, {
      unprovisionedAt: now.toISOString(),
    });
    result.unprovisioned.push(`integration:${integration.slug}`);
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
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.role.updated",
      entityType: "Role",
      entityId: role.id,
      data: formatRole(await db.roles.getAny(role.id, tx)) as Record<
        string,
        unknown
      >,
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
): Promise<{ problems: string[]; bucketNames: string[] }> => {
  const rows = new Map(
    (
      await tx.service.findMany({
        where: { slug: { in: p.services.map((e) => e.service.slug) } },
        include: { client: { include: { serviceAccountUser: true } } },
      })
    ).map((row) => [row.slug, row])
  );
  const problems: string[] = [];
  const bucketNames: string[] = [];

  for (const entry of p.services) {
    const row = rows.get(entry.service.slug)!;
    await asProblem(serviceLabel(entry), problems, async () => {
      const applied = await applyDeclarationTx(
        tx,
        // Its namespace is the entry's: findProblems refuses a change.
        { ...row, namespace: entry.service.namespace },
        declarationOf(entry.version, entry.service),
        SYSTEM_ACTOR,
        now,
        documentMeta(entry)
      );
      if (applied.changed) result.declared.push(`service:${row.slug}`);
      bucketNames.push(...applied.bucketNames);
    });
  }
  if (problems.length > 0) return { problems, bucketNames };

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
      const { lostPermissions, ...byVerb } = changes;
      for (const [verb, keys] of Object.entries(byVerb))
        for (const key of keys)
          result.access.push(`service:${row.slug} ${verb} ${key}`);
      if (
        await setRateLimitTx(
          tx,
          SYSTEM_ACTOR,
          accountUserId,
          entry.service.rateLimitPerSecond ?? null
        )
      )
        result.access.push(`service:${row.slug} rate limit`);
      // Tokens carry the permissions: a narrowed role's are stale too, even
      // when the same role also gained others.
      if (
        changes.revoked.length > 0 ||
        changes.narrowed.length > 0 ||
        lostPermissions
      )
        await db.accessTokens.revokeByClientId(client.id, tx);
    });
  }
  return { problems, bucketNames };
};

class DryRunRollback extends Error {
  constructor(public result: ProvisioningResult) {
    super("dry run");
  }
}

/**
 * Bring the database in line with the provisioning set, all or nothing:
 * every problem is reported before anything is written. Serialized, so
 * replicas starting together apply it once.
 */
export const applyProvisioning = async (
  set: ProvisioningSet,
  now: Date = new Date(),
  options: { dryRun?: boolean } = {}
): Promise<ProvisioningResult> => {
  const invalid = validateSet(set);
  if (invalid.length > 0) throw new ProvisioningError(invalid);
  const p = entriesOf(set);
  // Checked before images are stored, so a refused set stores none. Refused,
  // it is reported with the problems the transaction would find, which do not
  // depend on branding.
  const brandingProblems = await brandingClientProblems(prisma, set);
  if (brandingProblems.length > 0)
    throw new ProvisioningError([
      ...(await findProblems(prisma, p, await loadState(prisma, p))),
      ...(await groupProblems(prisma, set)),
      ...brandingProblems,
    ]);
  // A dry run stores them too; ones nothing references expire after the
  // grace period.
  const brandingImages = await storeProvisionedImages(set);

  let applied;
  try {
    applied = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${PROVISIONING_LOCK}, 0))`;
        const state = await loadState(tx, p);
        // Before any row is written: admin decisions take these first, then
        // rows.
        await lockRegistries(
          tx,
          [...state.services.values()]
            .filter((s) => s.kind === "service")
            .map((s) => s.id)
        );
        const problems = [
          ...(await findProblems(tx, p, state)),
          ...(await groupProblems(tx, set)),
        ];
        if (problems.length > 0) throw new ProvisioningError(problems);

        const result: ProvisioningResult = {
          created: [],
          updated: [],
          rotated: [],
          unprovisioned: [],
          declared: [],
          access: [],
          roles: [],
          branding: [],
          groups: [],
        };
        for (const entry of p.services)
          await applyService(tx, entry, state, now, result);
        const content = await applyServicesContent(tx, p, now, result);
        if (content.problems.length > 0)
          throw new ProvisioningError(content.problems);
        const roleChanges = await applyRoles(tx, p.roles, result);
        await applyGuests(tx, set);
        for (const entry of p.integrations)
          await applyIntegration(tx, entry, state, now, result);
        const integrationProblems = await applyIntegrationsAccess(
          tx,
          p,
          result
        );
        if (integrationProblems.length > 0)
          throw new ProvisioningError(integrationProblems);
        const groupChanges = await applyGroups(tx, set, now, result);
        for (const id of roleChanges.permissionsChanged)
          await revokeHolderClientTokens(tx, id);
        await applyWebhooks(tx, p, now, result);
        for (const entry of p.clients)
          await applyClient(tx, entry, state, now, result);
        await applyBranding(tx, set, brandingImages, result);
        await markMissing(tx, p, now, result);
        await markGroupsMissing(tx, set, now, result);
        // A dry run computed the result against the real rows; roll it back.
        if (options.dryRun) throw new DryRunRollback(result);
        return {
          result,
          bucketNames: content.bucketNames,
          roleChanges,
          groupChanges,
        };
      },
      { timeout: 120_000 }
    );
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result;
    throw err;
  }
  const { result, bucketNames, roleChanges, groupChanges } = applied;
  // The apply is committed, so a failure here is logged.
  const after = async (what: string, step: () => Promise<unknown>) => {
    try {
      await step();
    } catch (err) {
      logger.error({ err }, `Provisioning: ${what} failed after commit`);
    }
  };
  disconnectTokenSockets(roleChanges.revokedJtis);
  for (const id of roleChanges.permissionsChanged)
    await after("notifying a role's permission change", () =>
      notifyRolePermissionsChanged(id)
    );
  for (const id of roleChanges.statusChanged)
    await after("notifying a role's status change", () =>
      notifyRoleStatusChanged(id)
    );
  await after("notifying group members", async () =>
    afterGroupChange(groupChanges)
  );
  for (const name of new Set(bucketNames))
    await broadcastBucketInvalidate(name);
  if (result.branding.length > 0)
    await after("invalidating branding", invalidateBranding);
  return result;
};

/** A service client holding the role gets its next token with what it grants now. */
const revokeHolderClientTokens = async (tx: Tx, roleId: string) => {
  const holders = await db.roles.getUserIdsByRoleId(roleId, tx);
  const clientIds = new Set(
    holders.flatMap((h) => (h.user.oauthClientId ? [h.user.oauthClientId] : []))
  );
  for (const clientId of clientIds)
    await db.accessTokens.revokeByClientId(clientId, tx);
};

/**
 * Archives the custom roles dropped from the documents before `cutoff`. One
 * whose archiving would leave no administrator is kept, and tried again on
 * the next run.
 */
export const archiveDueRoles = async (
  tx: Tx,
  cutoff: Date,
  now: Date
): Promise<{ id: string; name: string }[]> => {
  const dueRoles = await tx.role.findMany({
    where: {
      provisioned: true,
      unprovisionedAt: { lte: cutoff },
      serviceId: null,
      archivedAt: null,
    },
  });
  const archivedRoles: { id: string; name: string }[] = [];
  for (const role of dueRoles) {
    try {
      await assertAdminRemains({ kind: "role", roleId: role.id }, tx);
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      logger.warn(
        { role: role.name },
        "Provisioning: a role removed from the documents was not archived, as it would leave no active administrator"
      );
      continue;
    }
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
  return archivedRoles;
};

// `now` is a parameter for tests.
export const deprovisionMissing = async (
  now: Date = new Date()
): Promise<{
  services: number;
  integrations: number;
  clients: number;
  roles: number;
  groups: number;
}> => {
  const cutoff = new Date(
    now.getTime() - env.REGISTRY_RETIREMENT_GRACE_HOURS * 60 * 60 * 1000
  );
  const {
    missingBuckets,
    jtis,
    services,
    integrations,
    clients,
    archivedRoles,
  } = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${PROVISIONING_LOCK}, 0))`;
      const stale = { provisioned: true, unprovisionedAt: { lte: cutoff } };
      const dueServices = await tx.service.findMany({
        where: { ...stale, kind: "service", isActive: true },
        include: { client: { include: { serviceAccountUser: true } } },
      });
      const missingBuckets: string[] = [];
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
        await db.accessTokens.revokeByClientId(client.id, tx);
        // No declaration is left to drop them from; they retire, and can be
        // deleted, as if one had. A cleared hash makes a return re-apply the
        // declaration, which brings back the buckets it lists.
        await tx.service.update({
          where: { id: service.id },
          data: { declarationHash: null },
        });
        const buckets = await tx.bucket.updateManyAndReturn({
          where: {
            serviceId: service.id,
            deletedAt: null,
            missingSince: null,
            retiredAt: null,
          },
          data: { missingSince: now },
          select: { name: true },
        });
        missingBuckets.push(...buckets.map((b) => b.name));
      }

      // Their tokens are revoked with the deactivation.
      const dueIntegrations = await tx.service.findMany({
        where: { ...stale, kind: "integration", isActive: true },
        select: { id: true },
      });
      for (const { id } of dueIntegrations)
        await updateIntegrationTx(
          tx,
          integrationRef(await db.services.getIntegration(id, tx)),
          { isActive: false },
          SYSTEM_ACTOR,
          { action: "unprovisioned" }
        );

      const dueClients = await tx.oAuthClient.findMany({
        where: { ...stale, service: { is: null } },
      });
      // Each delete holds its client's images to commit, so every profile
      // lock comes first: an admin save of a later client, holding that
      // lock and waiting on images, would deadlock with the loop.
      await db.brandingProfiles.lockManyForWrite(
        dueClients.map((c) => c.id),
        tx
      );
      const jtis: string[] = [];
      for (const client of dueClients)
        jtis.push(...(await deleteLoginClientTx(tx, client, SYSTEM_ACTOR)));

      const archivedRoles = await archiveDueRoles(tx, cutoff, now);
      for (const { id } of archivedRoles)
        await revokeHolderClientTokens(tx, id);
      return {
        missingBuckets,
        jtis,
        services: dueServices.length,
        integrations: dueIntegrations.length,
        clients: dueClients.length,
        archivedRoles,
      };
    },
    { timeout: 30_000 }
  );
  for (const name of missingBuckets) await broadcastBucketInvalidate(name);
  disconnectTokenSockets(jtis);
  // Deleted clients took their profiles with them.
  if (clients > 0) await invalidateAfterWrite();
  for (const { id } of archivedRoles) {
    notifyRoleDeleted(
      (await db.roles.getUserIdsByRoleId(id)).map((h) => h.userId)
    );
  }
  // Their own transactions: a group with many members, or one waiting on a
  // member's lock, fails alone, and the next run retries it.
  let groups = 0;
  try {
    const archivedGroups = await archiveDueGroups(
      (fn) =>
        prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${PROVISIONING_LOCK}, 0))`;
            return fn(tx);
          },
          { timeout: 30_000 }
        ),
      cutoff
    );
    afterGroupChange(archivedGroups);
    groups = archivedGroups.count;
  } catch (err) {
    logger.error({ err }, "Provisioning: archiving dropped groups failed");
  }
  const roles = archivedRoles.length;
  if (
    services > 0 ||
    integrations > 0 ||
    clients > 0 ||
    roles > 0 ||
    groups > 0
  )
    logger.info(
      { services, integrations, clients, roles, groups },
      "Retired entries removed from the provisioning file"
    );
  return { services, integrations, clients, roles, groups };
};
