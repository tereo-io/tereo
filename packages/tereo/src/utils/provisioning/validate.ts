import { ROLES, isRequestableCoreRole } from "../../definitions/roles.js";
import { hasPermission } from "../permissions.js";
import {
  CORE_DECLARATION,
  CORE_RESERVED_NAMESPACES,
  CORE_SERVICE,
  PERMISSION_CATALOG,
  RESERVED_EVENT_TYPES,
} from "../../definitions/index.js";
import {
  declarationProblems,
  namespacesOverlap,
  rolePrefixProblems,
  type ParsedDeclaration,
} from "../registry.js";
import type {
  LoadedDocument,
  ProvisioningSet,
  ResolvedService,
} from "./load.js";

interface ServiceInSet {
  file: string;
  version: string;
  service: ResolvedService;
}

const servicesOf = (set: ProvisioningSet): ServiceInSet[] =>
  set.documents.flatMap((d) =>
    d.service ? [{ file: d.file, version: d.version, service: d.service }] : []
  );

const serviceLabel = (file: string, service: ResolvedService) =>
  `${file}: services[${service.slug}]`;

const filesOf = (...files: string[]) => [...new Set(files)].join(" and ");

const splitRoleTarget = (target: string) => {
  const slash = target.indexOf("/");
  return slash === -1
    ? { slug: null, name: target }
    : { slug: target.slice(0, slash), name: target.slice(slash + 1) };
};

/**
 * The permissions `service`'s account will hold: those of each requestable
 * core role and each `<slug>/<name>` system role of another service in the
 * set that its `access.roles` lists. Targets that resolve to nothing add none.
 */
export const permissionsOfAccess = (
  set: ProvisioningSet,
  service: ResolvedService
): string[] => {
  const services = servicesOf(set);
  const permissions = new Set<string>();
  for (const target of service.access.roles) {
    const { slug, name } = splitRoleTarget(target);
    const role =
      slug === null
        ? isRequestableCoreRole(name)
          ? ROLES.find((r) => r.name === name)
          : undefined
        : slug === service.slug
          ? undefined
          : services
              .find((s) => s.service.slug === slug)
              ?.service.systemRoles.find((r) => r.name === name);
    for (const p of role?.permissions ?? []) permissions.add(p);
  }
  return [...permissions];
};

/** Reports each value that more than one entry claims, naming their files. */
const checkUnique = (
  kind: string,
  entries: { value: string; file: string }[],
  problems: string[]
) => {
  const files = new Map<string, string[]>();
  for (const { value, file } of entries)
    files.set(value, [...(files.get(value) ?? []), file]);
  for (const [value, owners] of files)
    if (owners.length > 1)
      problems.push(
        `${filesOf(...owners)}: ${kind} "${value}" is used by more than one entry`
      );
};

const checkSetUniqueness = (
  set: ProvisioningSet,
  services: ServiceInSet[],
  problems: string[]
) => {
  checkUnique(
    "service slug",
    services.map(({ file, service }) => ({ value: service.slug, file })),
    problems
  );
  checkUnique(
    "namespace",
    services.map(({ file, service }) => ({ value: service.namespace, file })),
    problems
  );
  checkUnique(
    "clientId",
    set.documents.flatMap((d) => [
      ...(d.service ? [{ value: d.service.clientId, file: d.file }] : []),
      ...d.clients.map((c) => ({ value: c.clientId, file: d.file })),
    ]),
    problems
  );
  checkUnique(
    "custom role",
    set.documents.flatMap((d) =>
      d.roles.map((r) => ({ value: r.name, file: d.file }))
    ),
    problems
  );
  // Duplicates within one declaration are its own rule (declarationProblems).
  const acrossServices = (names: (s: ResolvedService) => string[]) =>
    services.flatMap(({ file, service }) =>
      [...new Set(names(service))].map((value) => ({ value, file }))
    );
  checkUnique(
    "permission",
    acrossServices((s) => s.permissions.map((p) => p.name)),
    problems
  );
  checkUnique(
    "event type",
    acrossServices((s) => s.eventTypes.map((e) => e.eventType)),
    problems
  );
  checkUnique(
    "bucket",
    acrossServices((s) => s.buckets.map((b) => b.bucketName)),
    problems
  );

  services.forEach(({ file, service }, i) => {
    const label = serviceLabel(file, service);
    if (service.slug === CORE_SERVICE.slug)
      problems.push(`${label}: slug "${service.slug}" is core's`);
    const reserved = CORE_RESERVED_NAMESPACES.find((ns) =>
      namespacesOverlap(service.namespace, ns)
    );
    if (reserved)
      problems.push(
        `${label}: namespace "${service.namespace}" overlaps core's "${reserved}"`
      );
    for (const other of services.slice(i + 1)) {
      const a = service.namespace;
      const b = other.service.namespace;
      if (a !== b && namespacesOverlap(a, b))
        problems.push(
          `${filesOf(file, other.file)}: namespace "${a}" overlaps "${b}"`
        );
    }
  });
};

const checkAccess = (
  { file, service }: ServiceInSet,
  services: ServiceInSet[],
  problems: string[]
) => {
  const label = serviceLabel(file, service);
  for (const target of service.access.roles) {
    const { slug, name } = splitRoleTarget(target);
    if (slug === null) {
      if (!isRequestableCoreRole(name))
        problems.push(
          `${label}: access.roles "${target}" is not a core role services may request`
        );
      continue;
    }
    if (slug === service.slug) {
      problems.push(
        `${label}: access.roles "${target}" is this service's own role`
      );
      continue;
    }
    const owner = services.find((s) => s.service.slug === slug);
    if (!owner?.service.systemRoles.some((r) => r.name === name))
      problems.push(
        `${label}: access.roles "${target}" is not a system role declared in the provisioning set`
      );
  }
  for (const audience of service.access.audiences) {
    if (audience === service.slug)
      problems.push(
        `${label}: access.audiences "${audience}" is this service itself`
      );
    else if (!services.some((s) => s.service.slug === audience))
      problems.push(
        `${label}: access.audiences "${audience}" is not a service in the provisioning set`
      );
  }
};

const checkDeclaration = (
  { file, service }: ServiceInSet,
  problems: string[]
) => {
  const label = serviceLabel(file, service);
  const registryService = {
    id: "",
    slug: service.slug,
    namespace: service.namespace,
  };
  const declaration: ParsedDeclaration = {
    version: "0.0.0",
    permissions: service.permissions,
    systemRoles: service.systemRoles,
    buckets: service.buckets,
    eventTypes: service.eventTypes,
  };
  for (const p of [
    ...rolePrefixProblems(registryService, declaration),
    ...declarationProblems(registryService, declaration),
  ])
    problems.push(`${label}: ${p}`);
};

const CORE_EVENT_TYPES = CORE_DECLARATION.eventTypes;

const checkWebhooks = (
  set: ProvisioningSet,
  entry: ServiceInSet,
  services: ServiceInSet[],
  problems: string[]
) => {
  const { service } = entry;
  const label = serviceLabel(entry.file, service);
  const keys = service.webhooks.map((w) => w.key);
  for (const key of new Set(keys))
    if (keys.filter((k) => k === key).length > 1)
      problems.push(
        `${label}: webhook key "${key}" is used by more than one entry`
      );

  const held = permissionsOfAccess(set, service);
  const checked = new Set<string>();
  for (const webhook of service.webhooks) {
    // A repeated key is reported above; its events once are enough.
    if (checked.has(webhook.key)) continue;
    checked.add(webhook.key);
    const where = `${label}: webhooks[${webhook.key}]`;
    for (const event of webhook.events) {
      if (RESERVED_EVENT_TYPES.has(event)) {
        problems.push(`${where}: event "${event}" is reserved`);
        continue;
      }
      const type =
        services
          .flatMap((s) => s.service.eventTypes)
          .find((e) => e.eventType === event) ??
        CORE_EVENT_TYPES.find((e) => e.eventType === event);
      if (!type) {
        problems.push(
          `${where}: event "${event}" is declared by no service in the set nor by core`
        );
        continue;
      }
      if (type.readPermission && !hasPermission(held, type.readPermission)) {
        const own = service.eventTypes.some((e) => e.eventType === event);
        problems.push(
          own
            ? `${where}: ${service.slug} could not read ${event} (needs ${type.readPermission}); a service's account does not hold its own permissions, so add to access.roles a role of another service or a requestable core role granting it`
            : `${where}: ${service.slug} could not read ${event} (needs ${type.readPermission}); add a role granting it to access.roles`
        );
      }
    }
  }
};

const checkClients = (
  doc: LoadedDocument,
  services: ServiceInSet[],
  problems: string[]
) => {
  for (const client of doc.clients)
    for (const audience of client.audience)
      if (!services.some((s) => s.service.slug === audience))
        problems.push(
          `${doc.file}: clients[${client.clientId}]: audience "${audience}" is not a service in the provisioning set`
        );
};

const CORE_ROLE_NAMES = new Set(ROLES.map((r) => r.name));

const checkCustomRoles = (
  doc: LoadedDocument,
  services: ServiceInSet[],
  problems: string[]
) => {
  const orgAssignable = new Map<string, boolean>([
    ...PERMISSION_CATALOG.map((p) => [p.name, !!p.orgAssignable] as const),
    ...services.flatMap(({ service }) =>
      service.permissions.map((p) => [p.name, p.orgAssignable] as const)
    ),
  ]);

  for (const role of doc.roles) {
    const where = `roles[${role.name}]`;
    if (CORE_ROLE_NAMES.has(role.name))
      problems.push(
        `${doc.file}: ${where}: a system role of core is named "${role.name}"`
      );
    for (const { file, service } of services)
      if (service.systemRoles.some((r) => r.name === role.name))
        problems.push(
          `${filesOf(doc.file, file)}: ${where}: a system role of ${service.slug} is named "${role.name}"`
        );

    for (const permission of role.permissions) {
      if (orgAssignable.has(permission)) continue;
      // A permission under a service's namespace that it no longer declares
      // is usually a rollback of that service's document.
      const owner = services.find(({ service }) =>
        permission.startsWith(`${service.namespace}.`)
      );
      problems.push(
        owner
          ? `${filesOf(doc.file, owner.file)}: ${where}: permission "${permission}" is not declared by ${owner.service.slug} (${owner.file}, version ${owner.version})`
          : `${doc.file}: ${where}: permission "${permission}" is declared by no service in the set nor by core`
      );
    }

    if (role.orgAssignable) {
      const globalOnly = role.permissions.filter(
        (p) => orgAssignable.get(p) === false
      );
      if (globalOnly.length > 0)
        problems.push(
          `${doc.file}: ${where}: an org-assignable role may hold only org-assignable permissions: ${globalOnly
            .map((p) => `"${p}"`)
            .join(", ")}`
        );
    }
  }
};

/**
 * Every problem with the set as a whole, each prefixed with the file(s)
 * concerned. Needs no database: references resolve within the set or against
 * core's declaration. Empty when the set may be applied.
 */
export const validateSet = (set: ProvisioningSet): string[] => {
  const problems: string[] = [];
  const services = servicesOf(set);

  checkSetUniqueness(set, services, problems);

  for (const doc of set.documents) {
    if (doc.service) {
      const entry = {
        file: doc.file,
        version: doc.version,
        service: doc.service,
      };
      checkAccess(entry, services, problems);
      checkWebhooks(set, entry, services, problems);
      checkDeclaration(entry, problems);
    }
    checkClients(doc, services, problems);
    checkCustomRoles(doc, services, problems);
  }
  return problems;
};
