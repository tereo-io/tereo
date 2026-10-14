import type { BucketPermission } from "../../../../../../../prisma/generated/client/index.js";
import { getManagedBucket } from "../../../../../../utils/bucketAccess.js";
import { setAccessLog } from "../../../../../../middleware/accessLog.js";
import { emitTx, logAuditTx } from "../../../../../../utils/outbox.js";
import { validateUser } from "../../../../../../middleware/auth.js";
import db from "../../../../../../utils/db/index.js";
import { bucketNameSchema } from "../../schemas.js";
import { Request, Response } from "express";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../../../../../../utils/validateReq.js";
import {
  BadRequestError,
  ConflictError,
} from "../../../../../../utils/errors.js";
import {
  applyCursorToWhere,
  encodeListCursor,
} from "../../../../../../utils/cursor.js";
import {
  canActInOrganization,
  withUserRefs,
  userExists as authUserExists,
} from "../../../../../../utils/users.js";
import {
  grantPermissionSchema,
  listPermissionsQuerySchema,
} from "./schemas.js";

/**
 * Grants as the list and the grant return them: the grantee and the granter
 * each as a ref and, flat, by email and name.
 */
const serializePermissions = async (permissions: BucketPermission[]) =>
  (
    await withUserRefs(permissions, { user: "userId", granter: "grantedBy" })
  ).map((p) => ({
    id: p.id,
    userId: p.userId,
    userEmail: p.user?.email ?? null,
    userName: p.user?.name ?? null,
    user: p.user,
    canRead: p.canRead,
    canWrite: p.canWrite,
    canDelete: p.canDelete,
    grantedAt: p.grantedAt,
    grantedBy: p.grantedBy,
    grantedByEmail: p.granter?.email ?? null,
    grantedByName: p.granter?.name ?? null,
    granter: p.granter,
  }));

/**
 * List bucket permissions
 * GET /buckets/:name/permissions
 */
export const listPermissions = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name } = validateParams(bucketNameSchema, req);
  const query = validateQuery(listPermissionsQuerySchema, req);

  const bucket = await getManagedBucket(auth, name, "read");
  setAccessLog(res, { bucketId: bucket.id, operation: "LIST_PERMISSIONS" });

  const where = applyCursorToWhere(query);

  const result = await db.bucketPermissions.getPaginated({
    bucketId: bucket.id,
    take: query.limit,
    orderBy: query.orderBy,
    where,
  });

  const lastRow = result.data[result.data.length - 1];
  const nextCursor =
    result.hasMore && lastRow
      ? encodeListCursor({
          sort: query.sort,
          sortDir: query.sortDir,
          sortValue: (lastRow as unknown as Record<string, unknown>)[
            query.sortPrismaField
          ],
          id: lastRow.id,
        })
      : null;

  res.json({
    data: await serializePermissions(result.data),
    hasMore: result.hasMore,
    limit: query.limit,
    nextCursor,
  });
};

/**
 * Grant bucket access to a user
 * POST /buckets/:name/permissions
 */
export const grantPermission = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name } = validateParams(bucketNameSchema, req);
  const body = validateBody(grantPermissionSchema, req);

  const bucket = await getManagedBucket(auth, name, "write");

  const userExists = await authUserExists(body.userId);
  if (!userExists) {
    throw new BadRequestError("unknown_user", `User ${body.userId} not found`);
  }
  // Access to an organization's bucket is checked against the token's
  // organization, so an outsider's grant could never be used.
  if (
    bucket.organizationId &&
    !(await canActInOrganization(body.userId, bucket.organizationId))
  ) {
    throw new BadRequestError(
      "user_not_in_organization",
      `User ${body.userId} is not in the bucket's organization, so the grant could never be used`
    );
  }

  setAccessLog(res, { bucketId: bucket.id, operation: "GRANT_PERMISSION" });

  const existing = await db.bucketPermissions.getByBucketAndUser(
    bucket.id,
    body.userId
  );

  if (existing && !existing.revokedAt) {
    throw new ConflictError("Permission already exists for this user");
  }

  const permission = await db.$transaction(async (tx) => {
    let p;
    if (existing && existing.revokedAt) {
      p = await db.bucketPermissions.unrevoke(
        existing.id,
        {
          canRead: body.canRead,
          canWrite: body.canWrite,
          canDelete: body.canDelete,
          grantedBy: auth.userId,
        },
        tx
      );
      if (!p) {
        throw new ConflictError("Permission already exists for this user");
      }
    } else {
      p = await db.bucketPermissions.create(
        {
          bucketId: bucket.id,
          userId: body.userId,
          canRead: body.canRead,
          canWrite: body.canWrite,
          canDelete: body.canDelete,
          grantedBy: auth.userId,
        },
        tx
      );
    }

    await logAuditTx(tx, {
      auth,
      organizationId: bucket.organizationId ?? undefined,
      action: "CREATE",
      entityType: "bucketPermission",
      entityId: String(p.id),
      entityName: `${bucket.name}:${p.userId}`,
      metadata: {
        bucketName: bucket.name,
        targetUserId: p.userId,
        canRead: p.canRead,
        canWrite: p.canWrite,
        canDelete: p.canDelete,
      },
    });

    if (bucket.organizationId) {
      await emitTx(tx, {
        eventType: "file-service.permission.granted",
        organizationId: bucket.organizationId,
        entityType: "bucketPermission",
        entityId: String(p.id),
        data: {
          bucketName: bucket.name,
          userId: p.userId,
          canRead: p.canRead,
          canWrite: p.canWrite,
          canDelete: p.canDelete,
          grantedBy: p.grantedBy,
        },
      });
    }

    return p;
  });

  const [serialized] = await serializePermissions([permission]);
  res.status(201).json(serialized);
};
