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

type Tx = Prisma.TransactionClient;

const isServiceRole = (row: Pick<ServiceAccess, "kind" | "target">) =>
  row.kind === "role" && row.target.includes("/");

/**
 * For each row for another service's role, the permission names it was
 * approved for; null for core's roles and audiences.
 */
const withPermissions = async <T extends ServiceAccess>(rows: T[]) => {
  const ids = [...new Set(rows.flatMap((r) => r.approvedPermissionIds))];
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

  return rows.map(({ approvedPermissionIds, ...row }) => ({
    ...row,
    approvedPermissions: isServiceRole(row)
      ? named(approvedPermissionIds)
      : null,
  }));
};

/**
 * Add who decided each access row, from one lookup: `decider`, and its email
 * and name flat. The `decidedBy` id stays; all three are null until the row
 * is first decided, and name the last decision after. Rows for another
 * service's role also carry `approvedPermissions`.
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
 * Holds the registry lock of every service whose role these rows name, so
 * the permissions an approval records are still what the role grants when it
 * commits: provisioning takes these locks before changing a role.
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
  /** Permissions the role no longer grants, when it shrank. */
  removedPermissions?: string[];
}

export const decideAccessTx = async (
  tx: Tx,
  actor: AccessActor,
  service: { id: string; slug: string },
  rows: Decided[],
  status: "approved" | "revoked",
  meta: Record<string, unknown> = {}
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
    ...(r.removedPermissions && { removedPermissions: r.removedPermissions }),
  }));
  await logAuditTx(tx, {
    auth: actor,
    action: "UPDATE",
    entityType: "Service",
    entityId: service.id,
    entityName: service.slug,
    metadata: { action: `access_${status}`, access: decided, ...meta },
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
 * Give the service its access: a role on its account, or an audience.
 * Approving another service's role records the permissions it grants now.
 * With `checkGrantable`, the actor must hold whatever is newly granted.
 * Returns the rows it approved; those already approved are skipped.
 */
export const approveAccessTx = async (
  tx: Tx,
  actor: AccessActor,
  service: AppService,
  ids: string[],
  {
    checkGrantable = true,
    meta,
  }: { checkGrantable?: boolean; meta?: Record<string, unknown> } = {}
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
  await decideAccessTx(tx, actor, service, decided, "approved", meta);
  return rows;
};

/**
 * Take access away: the role off the service's account, or the audience off
 * its client. The caller revokes the service's tokens once this commits, so
 * its next token lacks what was revoked. Rows already revoked are skipped;
 * returns the rows it revoked.
 */
export const revokeAccessTx = async (
  tx: Tx,
  actor: AccessActor,
  service: AppService,
  rows: ServiceAccess[],
  meta: Record<string, unknown> = {}
): Promise<ServiceAccess[]> => {
  const revoking = rows.filter((r) => r.status !== "revoked");
  if (revoking.length === 0) return [];
  const audience = await lockedAudience(tx, service.client.id);
  for (const row of revoking) {
    if (row.kind === "role") {
      // A retired role keeps its assignment, which would grant again
      // should its owner declare the role once more.
      const role = await resolveRoleTarget(row.target, tx, {
        includeRetired: true,
      });
      if (role) {
        await tx.userRole.deleteMany({
          where: {
            userId: service.accountUserId,
            roleId: role.id,
            organizationId: null,
          },
        });
      }
      // Approving it again approves the role's permissions afresh.
      await tx.serviceAccess.update({
        where: { id: row.id },
        data: { approvedPermissionIds: [] },
      });
    } else {
      audience.delete(row.target);
    }
  }
  await tx.oAuthClient.update({
    where: { id: service.client.id },
    data: { audience: [...audience].sort() },
  });
  await decideAccessTx(tx, actor, service, revoking, "revoked", meta);
  return revoking;
};

const SYSTEM_ACTOR: AccessActor = { userId: SYSTEM_USER_ID, email: null };

const accessKey = (row: { kind: string; target: string }) =>
  `${row.kind}:${row.target}`;

/**
 * Make the service's access what its provisioning document lists, deciding
 * as core. Listed access not yet on file is approved, and so is listed
 * access core revoked because an earlier document stopped listing it; access
 * an admin revoked stays revoked. Approved access to another service's role
 * follows the role, recording what it grants now. Approved access no longer
 * listed is revoked. Every target must already exist: call after the
 * declarations.
 * The caller revokes the service's tokens when anything was revoked.
 */
export const syncProvisionedAccessTx = async (
  tx: Tx,
  service: AppService,
  wanted: { roles: string[]; audiences: string[] },
  now: Date,
  meta: Record<string, unknown> = {}
): Promise<{
  granted: string[];
  extended: string[];
  narrowed: string[];
  revoked: string[];
}> => {
  const want = [
    ...wanted.roles.map((target) => ({ kind: "role" as const, target })),
    ...wanted.audiences.map((target) => ({
      kind: "audience" as const,
      target,
    })),
  ];
  const wantedKeys = new Set(want.map(accessKey));
  // An admin's decision locks the client row before the access rows; so
  // does this, before writing any.
  await lockedAudience(tx, service.client.id);
  const existing = await tx.serviceAccess.findMany({
    where: { serviceId: service.id },
  });
  const known = new Set(existing.map(accessKey));
  await tx.serviceAccess.createMany({
    data: want
      .filter((w) => !known.has(accessKey(w)))
      .map((w) => ({ serviceId: service.id, ...w, requestedAt: now })),
    skipDuplicates: true,
  });
  const rows = await tx.serviceAccess.findMany({
    where: { serviceId: service.id },
    orderBy: [{ kind: "asc" }, { target: "asc" }],
  });
  const listed = rows.filter((r) => wantedKeys.has(accessKey(r)));

  // Rows created just above start pending; nothing else is.
  const toApprove = listed.filter(
    (r) =>
      r.status === "pending" ||
      (r.status === "revoked" && r.decidedBy === SYSTEM_USER_ID)
  );
  const approved =
    toApprove.length === 0
      ? []
      : await approveAccessTx(
          tx,
          SYSTEM_ACTOR,
          service,
          toApprove.map((r) => r.id),
          { checkGrantable: false, meta }
        );

  const extended: Decided[] = [];
  const narrowed: Decided[] = [];
  for (const row of listed) {
    if (row.status !== "approved" || !isServiceRole(row)) continue;
    const role = await resolveRoleTarget(row.target, tx);
    if (!role) continue;
    const granted = await tx.rolePermission.findMany({
      where: { roleId: role.id, permission: { retiredAt: null } },
      select: { permissionId: true, permission: { select: { name: true } } },
    });
    const before = new Set(row.approvedPermissionIds);
    const ids = granted.map((rp) => rp.permissionId);
    const added = granted.filter((rp) => !before.has(rp.permissionId));
    const current = new Set(ids);
    const removedIds = row.approvedPermissionIds.filter(
      (id) => !current.has(id)
    );
    if (added.length === 0 && removedIds.length === 0) continue;
    await tx.serviceAccess.update({
      where: { id: row.id },
      data: { approvedPermissionIds: ids },
    });
    const removedPermissions =
      removedIds.length === 0
        ? undefined
        : (
            await tx.permission.findMany({
              where: { id: { in: removedIds } },
              select: { name: true },
            })
          )
            .map((p) => p.name)
            .sort();
    const decided = {
      ...row,
      permissions: added.map((rp) => rp.permission.name).sort(),
      ...(removedPermissions && { removedPermissions }),
    };
    (added.length > 0 ? extended : narrowed).push(decided);
  }
  await decideAccessTx(
    tx,
    SYSTEM_ACTOR,
    service,
    [...extended, ...narrowed],
    "approved",
    meta
  );

  const revoked = await revokeAccessTx(
    tx,
    SYSTEM_ACTOR,
    service,
    rows.filter(
      (r) => r.status === "approved" && !wantedKeys.has(accessKey(r))
    ),
    meta
  );

  return {
    granted: approved.map(accessKey),
    extended: extended.map(accessKey),
    narrowed: narrowed.map(accessKey),
    revoked: revoked.map(accessKey),
  };
};
