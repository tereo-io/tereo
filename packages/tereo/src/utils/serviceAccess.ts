import type { ServiceAccess } from "../../prisma/generated/client/index.js";
import { CORE_SERVICE_ID, SYSTEM_USER_ID } from "../definitions/index.js";
import { assertCanGrant, globalGrantablePermissions } from "./grants.js";
import { NotFoundError, UnprocessableEntityError } from "./errors.js";
import { getDefaultOrganizationId } from "./defaultOrganization.js";
import { lockRegistries, resolveRoleTarget } from "./registry.js";
import { isRequestableCoreRole } from "../definitions/roles.js";
import { prisma, type Prisma } from "./db/prisma.js";
import { emitTx, logAuditTx } from "./outbox.js";
import { withUserRefs } from "./users.js";
import { logger } from "./logger.js";
import { z } from "zod";

type Tx = Prisma.TransactionClient;

const isServiceRole = (row: Pick<ServiceAccess, "kind" | "target">) =>
  row.kind === "role" && row.target.includes("/");

/**
 * For each request for another service's role, the permission names it was
 * approved for and those the role grants beyond them while it is pending;
 * both null for core's roles and audiences.
 */
const withPermissions = async <T extends ServiceAccess>(rows: T[]) => {
  const targets = new Set(rows.filter(isServiceRole).map((r) => r.target));
  const slugs = [...targets].map((t) => t.slice(0, t.indexOf("/")));
  const roles =
    targets.size === 0
      ? []
      : await prisma.role.findMany({
          where: {
            serviceId: { not: CORE_SERVICE_ID },
            service: { slug: { in: [...new Set(slugs)] } },
          },
          select: {
            name: true,
            service: { select: { slug: true } },
            rolePermissions: {
              where: { permission: { retiredAt: null } },
              select: { permissionId: true },
            },
          },
        });
  const current = new Map(
    roles.map((r) => [
      `${r.service!.slug}/${r.name}`,
      r.rolePermissions.map((rp) => rp.permissionId),
    ])
  );
  const ids = [
    ...new Set([
      ...rows.flatMap((r) => r.approvedPermissionIds),
      ...[...current.values()].flat(),
    ]),
  ];
  const names = new Map(
    ids.length === 0
      ? []
      : (
          await prisma.permission.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          })
        ).map((p) => [p.id, p.name])
  );
  const named = (list: string[]) =>
    list.flatMap((id) => names.get(id) ?? []).sort();

  return rows.map(({ approvedPermissionIds, ...row }) => {
    if (!isServiceRole(row)) {
      return { ...row, approvedPermissions: null, pendingPermissions: null };
    }
    const approved = new Set(approvedPermissionIds);
    const grants = current.get(row.target) ?? [];
    return {
      ...row,
      approvedPermissions: named(approvedPermissionIds),
      pendingPermissions:
        row.status === "pending"
          ? named(grants.filter((id) => !approved.has(id)))
          : [],
    };
  });
};

/**
 * Add who decided each access row, from one lookup: `decider`, and its email
 * and name flat. The `decidedBy` id stays; all three are null until the row
 * is first decided, and name the last decision after. Requests for another
 * service's role also carry `approvedPermissions` and `pendingPermissions`.
 */
export const withDeciders = async <T extends ServiceAccess>(rows: T[]) =>
  (
    await withPermissions(await withUserRefs(rows, { decider: "decidedBy" }))
  ).map((row) => ({
    ...row,
    decidedByEmail: row.decider?.email ?? null,
    decidedByName: row.decider?.name ?? null,
  }));

/** Who decides: an admin's token context, or core as `SYSTEM_USER_ID`. */
export interface AccessActor {
  userId: string;
  email: string | null;
  /** The token's ceiling, when the actor is a token. */
  ceiling?: string[];
}

/** An app service whose access is decided: its account holds the roles. */
export interface AppService {
  id: string;
  slug: string;
  accountUserId: string;
  client: { id: string };
}

/** The access rows named, all belonging to this service. */
export const accessRows = async (tx: Tx, serviceId: string, ids: string[]) => {
  const rows = await tx.serviceAccess.findMany({
    where: { id: { in: ids }, serviceId },
  });
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new NotFoundError(`Access requests not found: ${missing.join(", ")}`);
  }
  return rows;
};

/**
 * The client's audience, read with its row locked for the rest of the
 * transaction: two decisions at once would otherwise each rewrite the
 * audience they read before the other, and one would be lost.
 */
export const lockedAudience = async (tx: Tx, clientId: string) => {
  const rows = await tx.$queryRaw<{ audience: string[] }[]>`
    SELECT "audience" FROM "auth"."oauth_clients"
    WHERE "id" = ${clientId}::uuid
    FOR UPDATE`;
  return new Set(rows[0]?.audience ?? []);
};

/**
 * Holds the registration of every service whose role these rows request, so
 * the permissions an approval records are still what the role grants when it
 * commits: a registration adding one meanwhile would see no assignment yet
 * and reopen nothing.
 */
const lockRoleOwners = async (tx: Tx, serviceId: string, ids: string[]) => {
  const rows = await tx.serviceAccess.findMany({
    where: { id: { in: ids }, serviceId, kind: "role" },
    select: { target: true },
  });
  const slugs = rows
    .filter((r) => r.target.includes("/"))
    .map((r) => r.target.slice(0, r.target.indexOf("/")));
  if (slugs.length === 0) return;
  const owners = await tx.service.findMany({
    where: { slug: { in: slugs } },
    select: { id: true },
  });
  await lockRegistries(
    tx,
    owners.map((o) => o.id)
  );
};

/** A decided row; an approved role of another service names what it newly granted. */
interface Decided {
  id: string;
  kind: string;
  target: string;
  permissions?: string[];
}

export const decideAccessTx = async (
  tx: Tx,
  actor: AccessActor,
  service: { id: string; slug: string },
  rows: Decided[],
  status: "approved" | "revoked"
) => {
  if (rows.length === 0) return;
  await tx.serviceAccess.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { status, decidedAt: new Date(), decidedBy: actor.userId },
  });
  const decided = rows.map((r) => ({
    kind: r.kind,
    target: r.target,
    ...(r.permissions && { permissions: r.permissions }),
  }));
  await logAuditTx(tx, {
    auth: actor,
    action: "UPDATE",
    entityType: "Service",
    entityId: service.id,
    entityName: service.slug,
    metadata: { action: `access_${status}`, access: decided },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType:
      status === "approved"
        ? "core.service.access-approved"
        : "core.service.access-revoked",
    entityType: "Service",
    entityId: service.id,
    data: { id: service.id, slug: service.slug, access: decided },
  });
};

/**
 * Give the service what it asked for: a role on its account, or an audience.
 * Approving another service's role records the permissions it grants now;
 * what the role gains later comes back as pending and grants nothing until
 * approved too. With `checkGrantable`, the actor must hold whatever is newly
 * granted. Returns the rows it approved; those already approved are skipped.
 */
export const approveAccessTx = async (
  tx: Tx,
  actor: AccessActor,
  service: AppService,
  ids: string[],
  { checkGrantable = true }: { checkGrantable?: boolean } = {}
): Promise<ServiceAccess[]> => {
  await lockRoleOwners(tx, service.id, ids);
  const rows = (await accessRows(tx, service.id, ids)).filter(
    (r) => r.status !== "approved"
  );
  const audience = await lockedAudience(tx, service.client.id);
  const grantable = checkGrantable
    ? await globalGrantablePermissions(actor, tx)
    : null;
  const assertGrantable = (names: string[]) => {
    if (grantable) assertCanGrant(grantable, names);
  };
  const decided: Decided[] = [];
  for (const row of rows) {
    if (row.kind === "audience") {
      audience.add(row.target);
      decided.push(row);
      continue;
    }
    const role = await resolveRoleTarget(row.target, tx);
    if (!role) {
      throw new UnprocessableEntityError(
        "role_unavailable",
        `Role "${row.target}" no longer exists or is retired`
      );
    }
    const held = await tx.userRole.findFirst({
      where: {
        userId: service.accountUserId,
        roleId: role.id,
        organizationId: null,
      },
    });
    const granted = await tx.rolePermission.findMany({
      where: { roleId: role.id, permission: { retiredAt: null } },
      select: { permissionId: true, permission: { select: { name: true } } },
    });

    if (role.serviceId === CORE_SERVICE_ID) {
      if (!isRequestableCoreRole(role.name)) {
        throw new UnprocessableEntityError(
          "role_not_requestable",
          `Role "${row.target}" cannot be granted to a service`
        );
      }
      if (!held) {
        assertGrantable(granted.map((rp) => rp.permission.name));
        await tx.userRole.create({
          data: { userId: service.accountUserId, roleId: role.id },
        });
      }
      decided.push(row);
      continue;
    }

    const before = new Set(held ? row.approvedPermissionIds : []);
    const added = granted.filter((rp) => !before.has(rp.permissionId));
    assertGrantable(added.map((rp) => rp.permission.name));
    await tx.serviceAccess.update({
      where: { id: row.id },
      data: { approvedPermissionIds: granted.map((rp) => rp.permissionId) },
    });
    if (held) {
      await tx.userRole.update({
        where: { id: held.id },
        data: { serviceAccessId: row.id },
      });
    } else {
      await tx.userRole.create({
        data: {
          userId: service.accountUserId,
          roleId: role.id,
          serviceAccessId: row.id,
        },
      });
    }
    decided.push({
      ...row,
      permissions: added.map((rp) => rp.permission.name).sort(),
    });
  }
  await tx.oAuthClient.update({
    where: { id: service.client.id },
    data: { audience: [...audience].sort() },
  });
  await decideAccessTx(tx, actor, service, decided, "approved");
  return rows;
};

const ProvisionedAccessSchema = z.object({
  roles: z.array(z.string()),
  audiences: z.array(z.string()),
});

/**
 * Approve, as core, the service's requests its provisioning file lists. Only
 * requests never decided: one an admin revoked, or one reopened because the
 * role gained permissions, waits for an admin. A requested role that no
 * longer resolves is left pending rather than failing the caller.
 */
export const approveProvisionedAccess = async (
  serviceId: string
): Promise<void> => {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: {
      id: true,
      slug: true,
      provisioned: true,
      unprovisionedAt: true,
      provisionedAccess: true,
      client: {
        select: { id: true, serviceAccountUser: { select: { id: true } } },
      },
    },
  });
  if (!service?.provisioned || service.unprovisionedAt) return;
  const parsed = ProvisionedAccessSchema.safeParse(service.provisionedAccess);
  if (!parsed.success) {
    logger.warn(
      { serviceId: service.id, err: parsed.error },
      "Unreadable provisioned access; approving nothing"
    );
  }
  const access = parsed.success ? parsed.data : { roles: [], audiences: [] };
  const accountUserId = service.client?.serviceAccountUser?.id;
  if (!service.client || !accountUserId) return;
  if (access.roles.length + access.audiences.length === 0) return;

  const undecided = (tx: Tx) =>
    tx.serviceAccess.findMany({
      where: {
        serviceId,
        status: "pending",
        decidedAt: null,
        OR: [
          { kind: "role", target: { in: access.roles } },
          { kind: "audience", target: { in: access.audiences } },
        ],
      },
      select: { id: true, kind: true, target: true },
    });
  if ((await undecided(prisma)).length === 0) return;

  const app: AppService = {
    id: service.id,
    slug: service.slug,
    accountUserId,
    client: { id: service.client.id },
  };
  await prisma.$transaction(async (tx) => {
    // The locks an admin decision takes, so the rows read next stay
    // undecided until this commits.
    const candidates = await undecided(tx);
    await lockRoleOwners(
      tx,
      serviceId,
      candidates.map((r) => r.id)
    );
    await lockedAudience(tx, service.client!.id);
    // Only rows whose owners are locked above: locking another owner now,
    // after the client row, would invert the admin path's lock order.
    const locked = new Set(candidates.map((r) => r.id));
    const ids: string[] = [];
    for (const row of await undecided(tx)) {
      if (!locked.has(row.id)) continue;
      if (row.kind === "role" && !(await resolveRoleTarget(row.target, tx)))
        continue;
      ids.push(row.id);
    }
    if (ids.length === 0) return;
    await approveAccessTx(
      tx,
      { userId: SYSTEM_USER_ID, email: null },
      app,
      ids,
      { checkGrantable: false }
    );
  });
};
