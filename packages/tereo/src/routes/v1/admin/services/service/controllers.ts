import { getDefaultOrganizationId } from "../../../../../utils/defaultOrganization.js";
import { disconnectTokenSockets } from "../../../../../websocket/emitters/index.js";
import { prisma, type Prisma } from "../../../../../utils/db/prisma.js";
import { generateClientSecret } from "../../../../../utils/crypto.js";
import { CORE_SERVICE_ID } from "../../../../../definitions/index.js";
import { assertMayTakeOverAccount } from "../../users/user/guards.js";
import { formatService } from "../../../../../utils/transformers.js";
import { emitTx, logAuditTx } from "../../../../../utils/outbox.js";
import { updateServiceTx } from "../../../../../utils/services.js";
import { validateUser } from "../../../../../utils/auth.js";
import { logger } from "../../../../../utils/logger.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import env from "../../../../../env.js";
import {
  accessRows,
  approveAccessTx,
  revokeAccessTx,
  withDeciders,
} from "../../../../../utils/serviceAccess.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  revokePreviousSecretTx,
  rotatedSecretFields,
} from "../../../../../utils/clients.js";
import {
  ForbiddenError,
  InternalServerError,
  ManagedByProvisioningError,
  NotFoundError,
} from "../../../../../utils/errors.js";
import {
  AccessDecisionSchema,
  ServiceIdParamSchema,
  UpdateServiceSchema,
} from "./schemas.js";

type Tx = Prisma.TransactionClient;

const retirement = { missingSince: true, retiredAt: true } as const;

/** A service; integrations are managed under /admin/integrations. */
const getServiceRow = async (id: string, tx?: Tx) => {
  const service = await db.services.get(id, tx);
  if (service.kind !== "service") throw new NotFoundError("Service not found");
  return service;
};

/** An app service — core's own row is managed by code, not admins. */
const getAppService = async (req: Request, tx?: Tx) => {
  const { id } = validateParams(ServiceIdParamSchema, req);
  if (id === CORE_SERVICE_ID) {
    throw new ForbiddenError(
      "Core is managed by its code, not through this API"
    );
  }
  const service = await getServiceRow(id, tx);
  if (!service.client?.serviceAccountUser) {
    logger.error(
      { serviceId: service.id, slug: service.slug },
      "Service has no client or service account; its rows are inconsistent"
    );
    throw new InternalServerError();
  }
  return {
    ...service,
    client: service.client,
    accountUserId: service.client.serviceAccountUser.id,
  };
};

const getEditableAppService = async (req: Request) => {
  const service = await getAppService(req);
  if (service.provisioned) throw new ManagedByProvisioningError();
  return service;
};

/**
 * The service, what it declared (retired items included), its access, and
 * the settings that govern it — so an admin sees the real overlap and grace
 * period before acting.
 */
export const getService = async (req: Request, res: Response) => {
  const { id } = validateParams(ServiceIdParamSchema, req);
  const service = await getServiceRow(id);
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

  const { updated, revokedJtis } = await db.$transaction(async (tx) => {
    const revokedJtis =
      body.isActive === false
        ? await db.accessTokens.revokeByClientId(existing.client.id, tx)
        : [];
    const updated = await updateServiceTx(
      tx,
      existing,
      body,
      auth,
      revokedJtis.length > 0
        ? { accessTokensRevoked: revokedJtis.length }
        : undefined
    );
    return { updated, revokedJtis };
  });

  disconnectTokenSockets(revokedJtis);
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

  const { clientId, previousSecretExpiresAt } = await db.$transaction(
    async (tx) => {
      await assertMayTakeOverAccount(auth, service.accountUserId, tx);
      // Locked: two regenerations at once would each keep the secret they
      // read as the previous one, and the first one's new secret would be lost.
      const [client] = await tx.$queryRaw<
        {
          client_id: string;
          client_secret: string | null;
          previous_secret_hash: string | null;
          retired_secret_hashes: string[];
        }[]
      >`
        SELECT "client_id", "client_secret", "previous_secret_hash",
          "retired_secret_hashes"
        FROM "auth"."oauth_clients"
        WHERE "id" = ${service.client.id}::uuid
        FOR UPDATE`;
      if (!client) throw new NotFoundError("Client not found");
      const data = rotatedSecretFields(
        {
          clientSecret: client.client_secret,
          previousSecretHash: client.previous_secret_hash,
          retiredSecretHashes: client.retired_secret_hashes,
        },
        hashedSecret,
        new Date()
      );
      const { previousSecretExpiresAt } = data;
      await tx.oAuthClient.update({
        where: { id: service.client.id },
        data,
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

/**
 * End the overlap now: only the current secret works from here on. Allowed on
 * a provisioned service too, since the file cannot express it and a leaked
 * old secret must not wait out the overlap.
 */
export const revokePreviousSecret = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const service = await getAppService(req);

  const updated = await db.$transaction(async (tx) => {
    await assertMayTakeOverAccount(auth, service.accountUserId, tx);
    await revokePreviousSecretTx(tx, service.client.id);
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

/**
 * Give the service what it asked for: a role on its account, or an audience.
 * The approver must hold whatever is newly granted.
 */
export const approveAccess = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { ids } = validateBody(AccessDecisionSchema, req);
  const service = await getAppService(req);

  const approved = await db.$transaction((tx) =>
    approveAccessTx(tx, auth, service, ids)
  );

  res.json({
    approved: approved.map((r) => ({
      id: r.id,
      kind: r.kind,
      target: r.target,
    })),
  });
};

/**
 * Take access away. Its tokens are revoked with it, so the next call it
 * makes fetches a token without what was revoked.
 */
export const revokeAccess = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { ids } = validateBody(AccessDecisionSchema, req);
  const service = await getAppService(req);

  const { revoked, revokedJtis } = await db.$transaction(async (tx) => {
    const rows = await accessRows(tx, service.id, ids);
    // Revoked first, so the decision's audit entries can count them.
    const revokedJtis = rows.some((r) => r.status !== "revoked")
      ? await db.accessTokens.revokeByClientId(service.client.id, tx)
      : [];
    const revoked = await revokeAccessTx(tx, auth, service, rows, {
      accessTokensRevoked: revokedJtis.length,
    });
    return { revoked, revokedJtis };
  });

  disconnectTokenSockets(revokedJtis);
  res.json({
    revoked: revoked.map((r) => ({ id: r.id, kind: r.kind, target: r.target })),
  });
};
