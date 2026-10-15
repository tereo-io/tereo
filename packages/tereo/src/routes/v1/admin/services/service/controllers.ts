import { getDefaultOrganizationId } from "../../../../../utils/defaultOrganization.js";
import { prisma, type Prisma } from "../../../../../utils/db/prisma.js";
import { generateClientSecret } from "../../../../../utils/crypto.js";
import { CORE_SERVICE_ID } from "../../../../../definitions/index.js";
import { withDeciders } from "../../../../../utils/serviceAccess.js";
import { formatService } from "../../../../../utils/transformers.js";
import { emitTx, logAuditTx } from "../../../../../utils/outbox.js";
import { validateUser } from "../../../../../utils/auth.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import env from "../../../../../env.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  lockRegistries,
  resolveRoleTarget,
} from "../../../../../utils/registry.js";
import {
  assertCanGrant,
  globalGrantablePermissions,
} from "../../../../../utils/grants.js";
import {
  ForbiddenError,
  ManagedByProvisioningError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../../../../utils/errors.js";
import {
  AccessDecisionSchema,
  ServiceIdParamSchema,
  UpdateServiceSchema,
} from "./schemas.js";

type Tx = Prisma.TransactionClient;

const retirement = { missingSince: true, retiredAt: true } as const;

/** An app service — core's own row is managed by code, not admins. */
const getAppService = async (req: Request, tx?: Tx) => {
  const { id } = validateParams(ServiceIdParamSchema, req);
  if (id === CORE_SERVICE_ID) {
    throw new ForbiddenError(
      "Core is managed by its code, not through this API"
    );
  }
  const service = await db.services.get(id, tx);
  if (!service.client?.serviceAccountUser) {
    throw new Error(`Service ${service.slug} has no client or service account`);
  }
  return {
    ...service,
    client: service.client,
    accountUserId: service.client.serviceAccountUser.id,
  };
};

/** A service from the provisioning file changes there; its access is decided here. */
const getEditableAppService = async (req: Request) => {
  const service = await getAppService(req);
  if (service.provisioned) throw new ManagedByProvisioningError();
  return service;
};

/** Stop every outstanding token of the service's client. */
const revokeServiceTokens = async (clientRowId: string) => {
  await db.accessTokens.revokeByClientId(clientRowId);
};

/**
 * The service, what it declared (retired items included), its access, and
 * the settings that govern it — so an admin sees the real overlap and grace
 * period before acting.
 */
export const getService = async (req: Request, res: Response) => {
  const { id } = validateParams(ServiceIdParamSchema, req);
  const service = await db.services.get(id);
  const [permissions, systemRoles, buckets, eventTypes, access] =
    await Promise.all([
      prisma.permission.findMany({
        where: { serviceId: id },
        select: { id: true, name: true, displayName: true, ...retirement },
        orderBy: { name: "asc" },
      }),
      prisma.role.findMany({
        where: { serviceId: id },
        select: {
          id: true,
          name: true,
          displayName: true,
          ...retirement,
          rolePermissions: {
            select: { permission: { select: { name: true } } },
          },
        },
        orderBy: { name: "asc" },
      }),
      prisma.bucket.findMany({
        where: { serviceId: id },
        select: {
          id: true,
          name: true,
          policy: true,
          deletedAt: true,
          ...retirement,
        },
        orderBy: { name: "asc" },
      }),
      prisma.eventType.findMany({
        where: { serviceId: id },
        select: { eventType: true, description: true, ...retirement },
        orderBy: { eventType: "asc" },
      }),
      prisma.serviceAccess.findMany({
        where: { serviceId: id },
        orderBy: [{ kind: "asc" }, { target: "asc" }],
      }),
    ]);

  res.json({
    ...formatService(service),
    declared: {
      permissions,
      systemRoles: systemRoles.map(({ rolePermissions, ...role }) => ({
        ...role,
        permissions: rolePermissions.map((rp) => rp.permission.name),
      })),
      buckets,
      eventTypes,
    },
    access: await withDeciders(access),
    settings: {
      secretOverlapHours: env.SERVICE_SECRET_OVERLAP_HOURS,
      retirementGraceHours: env.REGISTRY_RETIREMENT_GRACE_HOURS,
    },
  });
};

/** Rename, deactivate or reactivate. A deactivated service's tokens stop. */
export const updateService = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(UpdateServiceSchema, req);
  const existing = await getEditableAppService(req);

  const updated = await db.$transaction(async (tx) => {
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
      auth,
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
  });

  if (body.isActive === false) await revokeServiceTokens(existing.client.id);
  res.json(formatService(updated));
};

/**
 * A new secret, shown once. The replaced one keeps working for
 * `SERVICE_SECRET_OVERLAP_HOURS`, so running copies survive the rollout.
 */
export const regenerateSecret = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const service = await getEditableAppService(req);
  const { plainSecret, hashedSecret } = generateClientSecret();
  const overlapMs = env.SERVICE_SECRET_OVERLAP_HOURS * 60 * 60 * 1000;

  const { clientId, previousSecretExpiresAt } = await db.$transaction(
    async (tx) => {
      // Locked: two regenerations at once would each keep the secret they
      // read as the previous one, and the first one's new secret would be lost.
      const [client] = await tx.$queryRaw<
        { client_id: string; client_secret: string | null }[]
      >`
        SELECT "client_id", "client_secret" FROM "auth"."oauth_clients"
        WHERE "id" = ${service.client.id}::uuid
        FOR UPDATE`;
      if (!client) throw new NotFoundError("Client not found");
      const previousSecretExpiresAt =
        overlapMs > 0 && client.client_secret
          ? new Date(Date.now() + overlapMs)
          : null;
      await tx.oAuthClient.update({
        where: { id: service.client.id },
        data: {
          clientSecret: hashedSecret,
          previousSecretHash: previousSecretExpiresAt
            ? client.client_secret
            : null,
          previousSecretExpiresAt,
        },
      });
      await logAuditTx(tx, {
        auth,
        action: "UPDATE",
        entityType: "Service",
        entityId: service.id,
        entityName: service.slug,
        metadata: { action: "secret_regenerated", previousSecretExpiresAt },
      });
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "core.service.secret-regenerated",
        entityType: "Service",
        entityId: service.id,
        data: { id: service.id, slug: service.slug, previousSecretExpiresAt },
      });
      return { clientId: client.client_id, previousSecretExpiresAt };
    }
  );

  res.json({
    clientId,
    clientSecret: plainSecret,
    previousSecretExpiresAt,
  });
};

/** End the overlap now: only the current secret works from here on. */
export const revokePreviousSecret = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const service = await getEditableAppService(req);

  const updated = await db.$transaction(async (tx) => {
    await tx.oAuthClient.update({
      where: { id: service.client.id },
      data: { previousSecretHash: null, previousSecretExpiresAt: null },
    });
    await logAuditTx(tx, {
      auth,
      action: "UPDATE",
      entityType: "Service",
      entityId: service.id,
      entityName: service.slug,
      metadata: { action: "previous_secret_revoked" },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "core.service.previous-secret-revoked",
      entityType: "Service",
      entityId: service.id,
      data: { id: service.id, slug: service.slug },
    });
    return db.services.get(service.id, tx);
  });

  res.json(formatService(updated));
};

/** The access rows named in the body, all belonging to this service. */
const accessRows = async (tx: Tx, serviceId: string, ids: string[]) => {
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
const lockedAudience = async (tx: Tx, clientId: string) => {
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

/**
 * Give the service what it asked for: a role on its account, or an audience.
 * Approving another service's role records the permissions it grants now;
 * what the role gains later comes back as pending and grants nothing until
 * approved here too. The approver must hold whatever is newly granted.
 */
export const approveAccess = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { ids } = validateBody(AccessDecisionSchema, req);
  const service = await getAppService(req);

  const approved = await db.$transaction(async (tx) => {
    await lockRoleOwners(tx, service.id, ids);
    const rows = (await accessRows(tx, service.id, ids)).filter(
      (r) => r.status !== "approved"
    );
    const audience = await lockedAudience(tx, service.client.id);
    const grantable = await globalGrantablePermissions(auth, tx);
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
        if (!held) {
          assertCanGrant(
            grantable,
            granted.map((rp) => rp.permission.name)
          );
          await tx.userRole.create({
            data: { userId: service.accountUserId, roleId: role.id },
          });
        }
        decided.push(row);
        continue;
      }

      const before = new Set(held ? row.approvedPermissionIds : []);
      const added = granted.filter((rp) => !before.has(rp.permissionId));
      assertCanGrant(
        grantable,
        added.map((rp) => rp.permission.name)
      );
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
    await decide(tx, auth, service, decided, "approved");
    return rows;
  });

  res.json({
    approved: approved.map((r) => ({
      id: r.id,
      kind: r.kind,
      target: r.target,
    })),
  });
};

/**
 * Take access away. Its tokens are revoked, so the next call it makes
 * fetches a token without what was revoked.
 */
export const revokeAccess = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { ids } = validateBody(AccessDecisionSchema, req);
  const service = await getAppService(req);

  const revoked = await db.$transaction(async (tx) => {
    const rows = (await accessRows(tx, service.id, ids)).filter(
      (r) => r.status !== "revoked"
    );
    const audience = await lockedAudience(tx, service.client.id);
    for (const row of rows) {
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
    await decide(tx, auth, service, rows, "revoked");
    return rows;
  });

  if (revoked.length > 0) await revokeServiceTokens(service.client.id);
  res.json({
    revoked: revoked.map((r) => ({ id: r.id, kind: r.kind, target: r.target })),
  });
};

/** A decided row; an approved role of another service names what it newly granted. */
interface Decided {
  id: string;
  kind: string;
  target: string;
  permissions?: string[];
}

const decide = async (
  tx: Tx,
  auth: { userId: string; email: string | null },
  service: { id: string; slug: string },
  rows: Decided[],
  status: "approved" | "revoked"
) => {
  if (rows.length === 0) return;
  await tx.serviceAccess.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { status, decidedAt: new Date(), decidedBy: auth.userId },
  });
  const decided = rows.map((r) => ({
    kind: r.kind,
    target: r.target,
    ...(r.permissions && { permissions: r.permissions }),
  }));
  await logAuditTx(tx, {
    auth,
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
