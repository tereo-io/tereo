import { getDefaultOrganizationId } from "./defaultOrganization.js";
import { PERMISSION_CATALOG } from "../definitions/permissions.js";
import { compareSemver, SEMVER_PATTERN } from "./semver.js";
import type { Declaration } from "../definitions/index.js";
import { emitTx, logAuditTx } from "./outbox.js";
import { ROLES } from "../definitions/roles.js";
import type { Prisma } from "./db/prisma.js";
import { prisma } from "./db/prisma.js";
import { logger } from "./logger.js";
import { createHash } from "crypto";
import env from "../env.js";
import { z } from "zod";
import {
  CORE_RESERVED_NAMESPACES,
  CORE_SERVICE_ID,
  SYSTEM_USER_ID,
} from "../definitions/index.js";
import {
  BadRequestError,
  ConflictError,
  UnprocessableEntityError,
} from "./errors.js";

/**
 * The registry: each service (core included) declares the permissions,
 * system roles, buckets and event types it owns, all named under its
 * namespace — core in code, app services in their provisioning documents.
 * A declaration is applied whole; whatever it stops listing is marked
 * missing and retired after `REGISTRY_RETIREMENT_GRACE_HOURS`.
 */

type Tx = Prisma.TransactionClient;

// Lowercase words joined by single hyphens: `product`, `order-lines`.
export const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const nameField = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, "lowercase letters, digits, . _ -");

export const permissionItem = z.object({
  name: nameField(100),
  displayName: z.string().min(1).max(255),
  description: z.string().max(500).default(""),
  orgAssignable: z.boolean().default(false),
});

export const systemRoleItem = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_-]*$/, "lowercase letters, digits, _ -"),
  displayName: z.string().min(1).max(255),
  description: z.string().max(500).default(""),
  permissions: z.array(z.string().min(1).max(200)).max(1000).default([]),
});

export const bucketItem = z.object({
  bucketName: z
    .string()
    .min(3)
    .max(63)
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
      "lowercase alphanumeric with hyphens"
    ),
  description: z.string().max(500).optional(),
  policy: z.enum(["public", "private"]).default("private"),
  storageQuotaBytes: z.number().int().positive().optional(),
});

export const eventTypeItem = z.object({
  eventType: nameField(100),
  description: z.string().max(500).default(""),
  readPermission: z.string().min(1).max(200).optional(),
});

export const declarationSchema = z.object({
  version: z
    .string()
    .max(64)
    .regex(SEMVER_PATTERN, "a semver version: MAJOR.MINOR.PATCH[-prerelease]"),
  permissions: z.array(permissionItem).max(1000).default([]),
  systemRoles: z.array(systemRoleItem).max(200).default([]),
  buckets: z.array(bucketItem).max(100).default([]),
  eventTypes: z.array(eventTypeItem).max(1000).default([]),
});

export type ParsedDeclaration = z.infer<typeof declarationSchema>;

export interface RegistryService {
  id: string;
  slug: string;
  namespace: string;
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/** `a` and `b` claim overlapping names: equal, or one a hyphenated extension. */
export const namespacesOverlap = (a: string, b: string) =>
  a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);

/**
 * Serializes namespace claims (a new service) against bucket names that fall
 * under one (an admin's bucket), so the two checks below can't both pass for
 * a namespace and a bucket created at the same moment. Inside a transaction.
 */
export const lockNamespaces = (tx: Tx) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('registry:namespaces', 0))`;

// Integrations have none.
const serviceNamespaces = async (tx: Tx): Promise<string[]> =>
  (
    await tx.service.findMany({
      where: { namespace: { not: null } },
      select: { namespace: true },
    })
  ).flatMap((s) => (s.namespace ? [s.namespace] : []));

/**
 * Throws unless `namespace` is well-formed and clear of every other service's
 * namespace, of core's reserved prefixes, and of buckets admins created under
 * it: the service could never declare those, so its registration would fail.
 * Call in a transaction, which it locks with `lockNamespaces`.
 */
export const assertNamespaceAvailable = async (
  namespace: string,
  tx: Tx = prisma
): Promise<void> => {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new UnprocessableEntityError(
      "invalid_namespace",
      "Namespace must be lowercase words joined by hyphens"
    );
  }
  if (tx !== prisma) await lockNamespaces(tx);
  const taken = [...CORE_RESERVED_NAMESPACES, ...(await serviceNamespaces(tx))];
  const clash = taken.find((other) => namespacesOverlap(namespace, other));
  if (clash) {
    throw new ConflictError(
      `Namespace "${namespace}" overlaps "${clash}", which is already taken`
    );
  }
  const buckets = await tx.bucket.findMany({
    where: {
      serviceId: null,
      deletedAt: null,
      name: { startsWith: `${namespace}-` },
    },
    select: { name: true },
    orderBy: { name: "asc" },
    take: 5,
  });
  if (buckets.length > 0) {
    throw new ConflictError(
      `Namespace "${namespace}" would own buckets created outside any service (${buckets
        .map((b) => `"${b.name}"`)
        .join(", ")}); rename or delete them, or choose another namespace`
    );
  }
};

const namespacesOf = (service: RegistryService): readonly string[] =>
  service.id === CORE_SERVICE_ID
    ? CORE_RESERVED_NAMESPACES
    : [service.namespace];

/** Permissions and event types: `<ns>` or `<ns>.…`. Buckets: `<ns>-…`. */
const inNamespace = (name: string, namespaces: readonly string[]) =>
  namespaces.some((ns) => name === ns || name.startsWith(`${ns}.`));
const bucketInNamespace = (name: string, namespaces: readonly string[]) =>
  namespaces.some((ns) => name.startsWith(`${ns}-`));

/**
 * Refuses a bucket name under core's or a registered service's namespace: those
 * names belong to declarations, and an admin-created one would make the owning
 * service's next registration fail. Call in the transaction that creates the
 * bucket, which it locks with `lockNamespaces`.
 */
export const assertBucketNameUnreserved = async (
  name: string,
  tx: Tx = prisma
): Promise<void> => {
  if (tx !== prisma) await lockNamespaces(tx);
  const owner = [
    ...CORE_RESERVED_NAMESPACES,
    ...(await serviceNamespaces(tx)),
  ].find((ns) => bucketInNamespace(name, [ns]));
  if (owner) {
    throw new ConflictError(
      `Bucket names starting with "${owner}-" are reserved for the "${owner}" namespace's declared buckets`
    );
  }
};

const duplicates = (names: string[]) =>
  [...new Set(names.filter((n, i) => names.indexOf(n) !== i))].sort();

/**
 * An app service's system roles are named `<namespace>_…`, so a role's name
 * says whose it is. Core's are exempt: their names predate the rule and are
 * the ones services request by bare name.
 */
export const rolePrefixProblems = (
  service: RegistryService,
  d: ParsedDeclaration
): string[] => {
  if (service.id === CORE_SERVICE_ID) return [];
  const prefix = `${service.namespace}_`;
  const unprefixed = d.systemRoles
    .map((r) => r.name)
    .filter((n) => !n.startsWith(prefix) || n.length === prefix.length);
  return unprefixed.length > 0
    ? [
        `System role names must start with "${prefix}" followed by a name: ${unprefixed.join(", ")}`,
      ]
    : [];
};

const CORE_ROLE_NAMES = new Set(ROLES.map((r) => r.name));
const CORE_PERMISSION_NAMES = new Set(PERMISSION_CATALOG.map((p) => p.name));

/** Everything wrong with a declaration that needs no database to see. */
export const declarationProblems = (
  service: RegistryService,
  d: ParsedDeclaration
): string[] => {
  const namespaces = namespacesOf(service);
  const problems: string[] = [];
  const outside = (kind: string, names: string[]) => {
    if (names.length > 0) {
      problems.push(
        `${kind} outside namespace "${namespaces.join(", ")}": ${names.join(", ")}`
      );
    }
  };
  outside(
    "permissions",
    d.permissions.map((p) => p.name).filter((n) => !inNamespace(n, namespaces))
  );
  outside(
    "event types",
    d.eventTypes
      .map((e) => e.eventType)
      .filter((n) => !inNamespace(n, namespaces))
  );
  outside(
    "buckets",
    d.buckets
      .map((b) => b.bucketName)
      .filter((n) => !bucketInNamespace(n, namespaces))
  );

  for (const [kind, names] of [
    ["permissions", d.permissions.map((p) => p.name)],
    ["system roles", d.systemRoles.map((r) => r.name)],
    ["buckets", d.buckets.map((b) => b.bucketName)],
    ["event types", d.eventTypes.map((e) => e.eventType)],
  ] as const) {
    const dupes = duplicates([...names]);
    if (dupes.length > 0) {
      problems.push(`duplicate ${kind}: ${dupes.join(", ")}`);
    }
  }

  // A namespace such as `user` could still spell one of core's role names
  // (`user_resolver`); two in the admin UI invite assigning the wrong one.
  if (service.id !== CORE_SERVICE_ID) {
    const shadowing = d.systemRoles
      .map((r) => r.name)
      .filter((n) => CORE_ROLE_NAMES.has(n));
    if (shadowing.length > 0) {
      problems.push(
        `system roles named like core's own: ${shadowing.join(", ")}`
      );
    }
  }

  const declared = new Set(d.permissions.map((p) => p.name));
  for (const role of d.systemRoles) {
    const foreign = role.permissions.filter((p) => !declared.has(p));
    if (foreign.length > 0) {
      problems.push(
        `system role "${role.name}" grants permissions this declaration does not declare: ${foreign.join(", ")}`
      );
    }
  }
  const unreadable = d.eventTypes.filter(
    (e) =>
      e.readPermission !== undefined &&
      !declared.has(e.readPermission) &&
      !CORE_PERMISSION_NAMES.has(e.readPermission)
  );
  if (unreadable.length > 0) {
    problems.push(
      `event types read with a permission neither this declaration nor core declares: ${unreadable
        .map((e) => `${e.eventType} (${e.readPermission})`)
        .join(", ")}`
    );
  }
  return problems;
};

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

const byKey =
  <T>(key: (item: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

/** Stable JSON: object keys sorted, so equal declarations hash equally. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(byKey(([k]) => k));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/** Order-insensitive: listing the same items in another order is no change. */
export const declarationHash = (d: ParsedDeclaration): string => {
  const normalized = {
    permissions: [...d.permissions].sort(byKey((p) => p.name)),
    systemRoles: [...d.systemRoles]
      .map((r) => ({ ...r, permissions: [...new Set(r.permissions)].sort() }))
      .sort(byKey((r) => r.name)),
    buckets: [...d.buckets].sort(byKey((b) => b.bucketName)),
    eventTypes: [...d.eventTypes].sort(byKey((e) => e.eventType)),
  };
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
};

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export interface RegisterResult {
  /** False when the declaration's version is older than the one applied. */
  applied: boolean;
  changed: boolean;
}

/**
 * An access role target, resolved: `name` is one of core's system roles,
 * `<slug>/<name>` another service's.
 */
export const resolveRoleTarget = async (
  target: string,
  tx: Tx = prisma,
  { includeRetired = false } = {}
) => {
  const slash = target.indexOf("/");
  const slug = slash === -1 ? null : target.slice(0, slash);
  const name = slash === -1 ? target : target.slice(slash + 1);
  const service = slug
    ? await tx.service.findUnique({ where: { slug } })
    : { id: CORE_SERVICE_ID };
  if (!service) return null;
  return tx.role.findFirst({
    where: {
      serviceId: service.id,
      name,
      ...(!includeRetired && { retiredAt: null }),
    },
  });
};

/** The service-account user a service's grants and buckets belong to. */
const serviceAccountUserId = async (
  service: RegistryService,
  tx: Tx
): Promise<string> => {
  if (service.id === CORE_SERVICE_ID) return SYSTEM_USER_ID;
  const row = await tx.service.findUniqueOrThrow({
    where: { id: service.id },
    select: { client: { select: { serviceAccountUser: true } } },
  });
  const user = row.client?.serviceAccountUser;
  if (!user) {
    throw new Error(`Service ${service.slug} has no service-account user`);
  }
  return user.id;
};

/**
 * Holds each service's registration until the transaction ends. Taken in
 * sorted order, so two callers locking several services can't deadlock.
 */
export const lockRegistries = async (tx: Tx, serviceIds: Iterable<string>) => {
  for (const id of [...new Set(serviceIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`registry:${id}`}, 0))`;
  }
};

/**
 * Apply core's own declaration, in-process. One whose version is older than
 * the applied one is ignored, so a replica of an earlier release that
 * restarts after a rollout cannot undo it. Unchanged (same hash) is a no-op
 * beyond recording a newer version. A declaration that breaks a rule is
 * refused whole, with every problem listed. Serialized, so copies starting
 * together apply it once. App services' declarations come from provisioning.
 */
export const registerDeclaration = async (
  service: RegistryService,
  input: Declaration | ParsedDeclaration,
  actor: { userId: string; email: string | null }
): Promise<RegisterResult> => {
  const declaration = declarationSchema.parse(input);
  const hash = declarationHash(declaration);

  const unprefixed = rolePrefixProblems(service, declaration);
  if (unprefixed.length > 0) {
    throw new BadRequestError("invalid_role_name", unprefixed.join("; "));
  }
  const problems = declarationProblems(service, declaration);
  if (problems.length > 0) {
    throw new UnprocessableEntityError(
      "invalid_declaration",
      problems.join("; ")
    );
  }

  const { version } = declaration;
  const ignored = (stored: string): RegisterResult => {
    logger.warn(
      {
        service: service.slug,
        storedVersion: stored,
        receivedVersion: version,
      },
      "Ignored a declaration older than the one applied"
    );
    return { applied: false, changed: false };
  };
  const isOlder = (stored: string | null): stored is string =>
    stored !== null && compareSemver(version, stored) < 0;

  const current = await prisma.service.findUniqueOrThrow({
    where: { id: service.id },
  });
  if (isOlder(current.declarationVersion)) {
    return ignored(current.declarationVersion);
  }
  if (
    current.declarationHash === hash &&
    current.declarationVersion === version
  ) {
    return { applied: true, changed: false };
  }

  return prisma.$transaction(
    async (tx) => {
      await lockRegistries(tx, [service.id]);
      const locked = await tx.service.findUniqueOrThrow({
        where: { id: service.id },
      });
      if (isOlder(locked.declarationVersion)) {
        return ignored(locked.declarationVersion);
      }
      if (locked.declarationHash === hash) {
        if (locked.declarationVersion !== version) {
          await tx.service.update({
            where: { id: service.id },
            data: { declarationVersion: version },
          });
        }
        return { applied: true, changed: false };
      }

      const { summary } = await applyDeclarationTx(
        tx,
        service,
        declaration,
        actor,
        new Date()
      );
      logger.info(
        { service: service.slug, version, hash, ...summary },
        "Registered declaration"
      );
      return { applied: true, changed: true };
    },
    { timeout: 30_000 }
  );
};

interface ApplySummary {
  declared: number;
  missing: number;
}

export interface ApplySummaryByKind {
  permissions: ApplySummary;
  systemRoles: ApplySummary;
  buckets: ApplySummary;
  eventTypes: ApplySummary;
}

/**
 * Write a declaration's permissions, system roles, buckets and event types,
 * record its hash and version, audit it and emit `core.service.declared`.
 * Skipped when the stored hash and version are already these. An older
 * version is applied too, with a warning: callers that must refuse one check
 * first. Call with the service's registry locked.
 */
export const applyDeclarationTx = async (
  tx: Tx,
  service: RegistryService,
  declaration: ParsedDeclaration,
  actor: { userId: string; email: string | null },
  now: Date,
  meta: Record<string, unknown> = {}
): Promise<{ changed: boolean; summary: ApplySummaryByKind }> => {
  const { version } = declaration;
  const hash = declarationHash(declaration);
  const stored = await tx.service.findUniqueOrThrow({
    where: { id: service.id },
    select: { declarationHash: true, declarationVersion: true },
  });
  if (
    stored.declarationHash === hash &&
    stored.declarationVersion === version
  ) {
    const none = { declared: 0, missing: 0 };
    return {
      changed: false,
      summary: {
        permissions: none,
        systemRoles: none,
        buckets: none,
        eventTypes: none,
      },
    };
  }
  if (
    stored.declarationVersion !== null &&
    compareSemver(version, stored.declarationVersion) < 0
  ) {
    logger.warn(
      {
        service: service.slug,
        storedVersion: stored.declarationVersion,
        appliedVersion: version,
      },
      "Applied a declaration older than the one applied before"
    );
  }

  const summary = {
    permissions: await applyPermissions(tx, service, declaration, now),
    systemRoles: await applyRoles(tx, service, declaration, now),
    buckets: await applyBuckets(tx, service, declaration, now),
    eventTypes: await applyEventTypes(tx, service, declaration, now),
  };

  await tx.service.update({
    where: { id: service.id },
    data: {
      declarationHash: hash,
      declarationVersion: version,
      declaredAt: now,
    },
  });
  await logAuditTx(tx, {
    auth: actor,
    action: "UPDATE",
    entityType: "Service",
    entityId: service.id,
    entityName: service.slug,
    metadata: { via: "declaration", ...meta, version, hash, ...summary },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "core.service.declared",
    entityType: "Service",
    entityId: service.id,
    data: { slug: service.slug, version, hash, ...summary },
  });
  return { changed: true, summary };
};

/** Declared items clear `missing_since`/`retired_at`; the rest start missing. */
const present = { missingSince: null, retiredAt: null };

const refuseForeign = (
  kind: string,
  names: string[],
  service: RegistryService
) => {
  if (names.length > 0) {
    throw new ConflictError(
      `${kind} already owned by another service or an admin, not ${service.slug}: ${names.join(", ")}`
    );
  }
};

const applyPermissions = async (
  tx: Tx,
  service: RegistryService,
  d: ParsedDeclaration,
  now: Date
): Promise<ApplySummary> => {
  const names = d.permissions.map((p) => p.name);
  const existing = await tx.permission.findMany({
    where: { name: { in: names } },
  });
  refuseForeign(
    "Permissions",
    existing.filter((p) => p.serviceId !== service.id).map((p) => p.name),
    service
  );
  for (const p of d.permissions) {
    await tx.permission.upsert({
      where: { name: p.name },
      update: {
        displayName: p.displayName,
        description: p.description,
        orgAssignable: p.orgAssignable,
        ...present,
      },
      create: {
        name: p.name,
        displayName: p.displayName,
        description: p.description,
        orgAssignable: p.orgAssignable,
        serviceId: service.id,
      },
    });
  }
  const { count } = await tx.permission.updateMany({
    where: {
      serviceId: service.id,
      name: { notIn: names },
      missingSince: null,
      retiredAt: null,
    },
    data: { missingSince: now },
  });
  return { declared: names.length, missing: count };
};

const applyRoles = async (
  tx: Tx,
  service: RegistryService,
  d: ParsedDeclaration,
  now: Date
): Promise<ApplySummary> => {
  const names = d.systemRoles.map((r) => r.name);
  for (const r of d.systemRoles) {
    const fields = {
      displayName: r.displayName,
      description: r.description,
      isActive: true,
      archivedAt: null,
      ...present,
    };
    const role = await tx.role.upsert({
      where: { serviceId_name: { serviceId: service.id, name: r.name } },
      update: fields,
      create: { name: r.name, serviceId: service.id, ...fields },
    });
    const permissions = await tx.permission.findMany({
      where: { name: { in: r.permissions }, serviceId: service.id },
      select: { id: true },
    });
    await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
    await tx.rolePermission.createMany({
      data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
    });
  }
  const { count } = await tx.role.updateMany({
    where: {
      serviceId: service.id,
      name: { notIn: names },
      missingSince: null,
      retiredAt: null,
    },
    data: { missingSince: now },
  });
  return { declared: names.length, missing: count };
};

const applyBuckets = async (
  tx: Tx,
  service: RegistryService,
  d: ParsedDeclaration,
  now: Date
): Promise<ApplySummary> => {
  const names = d.buckets.map((b) => b.bucketName);
  const existing = await tx.bucket.findMany({
    where: { name: { in: names }, deletedAt: null },
  });
  refuseForeign(
    "Buckets",
    existing.filter((b) => b.serviceId !== service.id).map((b) => b.name),
    service
  );

  const userId =
    names.length > 0 ? await serviceAccountUserId(service, tx) : null;
  for (const b of d.buckets) {
    // Only the description is re-applied; admins tune the rest, and
    // utils/bucketAccess.ts refuses their edits to the description.
    const live = existing.find((e) => e.name === b.bucketName);
    const bucket = live
      ? await tx.bucket.update({
          where: { id: live.id },
          data: { description: b.description, ...present },
        })
      : await tx.bucket.create({
          data: {
            name: b.bucketName,
            description: b.description,
            policy: b.policy,
            storageQuotaBytes:
              b.storageQuotaBytes === undefined
                ? undefined
                : BigInt(b.storageQuotaBytes),
            serviceId: service.id,
            createdBy: userId!,
            ownerId: userId!,
          },
        });
    // Core reaches its buckets in-process; an app service gets a grant on
    // what it declares.
    if (service.id !== CORE_SERVICE_ID) {
      const grant = {
        canRead: true,
        canWrite: true,
        canDelete: true,
        revokedAt: null,
        revokedBy: null,
      };
      await tx.bucketPermission.upsert({
        where: { bucketId_userId: { bucketId: bucket.id, userId: userId! } },
        update: grant,
        create: {
          bucketId: bucket.id,
          userId: userId!,
          grantedBy: SYSTEM_USER_ID,
          ...grant,
        },
      });
    }
  }
  const { count } = await tx.bucket.updateMany({
    where: {
      serviceId: service.id,
      name: { notIn: names },
      missingSince: null,
      retiredAt: null,
    },
    data: { missingSince: now },
  });
  return { declared: names.length, missing: count };
};

const applyEventTypes = async (
  tx: Tx,
  service: RegistryService,
  d: ParsedDeclaration,
  now: Date
): Promise<ApplySummary> => {
  const names = d.eventTypes.map((e) => e.eventType);
  const existing = await tx.eventType.findMany({
    where: { eventType: { in: names } },
  });
  refuseForeign(
    "Event types",
    existing.filter((e) => e.serviceId !== service.id).map((e) => e.eventType),
    service
  );
  for (const e of d.eventTypes) {
    await tx.eventType.upsert({
      where: { eventType: e.eventType },
      update: {
        description: e.description,
        source: service.slug,
        readPermission: e.readPermission ?? null,
        ...present,
      },
      create: {
        eventType: e.eventType,
        description: e.description,
        source: service.slug,
        serviceId: service.id,
        readPermission: e.readPermission ?? null,
      },
    });
  }
  const { count } = await tx.eventType.updateMany({
    where: {
      serviceId: service.id,
      eventType: { notIn: names },
      missingSince: null,
      retiredAt: null,
    },
    data: { missingSince: now },
  });
  return { declared: names.length, missing: count };
};

// ---------------------------------------------------------------------------
// Retirement
// ---------------------------------------------------------------------------

/**
 * Retire every item missing from its declaration for longer than the grace
 * period. Run hourly by the worker; `now` is a parameter for tests.
 */
export const retireMissing = async (now = new Date()) => {
  const cutoff = new Date(
    now.getTime() - env.REGISTRY_RETIREMENT_GRACE_HOURS * 60 * 60 * 1000
  );
  const where = { missingSince: { lte: cutoff }, retiredAt: null };
  const data = { retiredAt: now };
  const [permissions, roles, buckets, eventTypes] = await prisma.$transaction([
    prisma.permission.updateMany({ where, data }),
    prisma.role.updateMany({ where, data }),
    prisma.bucket.updateMany({ where, data }),
    prisma.eventType.updateMany({ where, data }),
  ]);
  const result = {
    permissions: permissions.count,
    roles: roles.count,
    buckets: buckets.count,
    eventTypes: eventTypes.count,
  };
  if (Object.values(result).some((n) => n > 0)) {
    logger.info(result, "Retired items missing from their declarations");
  }
  return result;
};
