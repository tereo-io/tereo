import type { BucketPermission } from "../../../../../../../prisma/generated/client/index.js";
import { notifyBucketAccessChanged } from "../../../../../../websocket/emitters/index.js";
import { getManagedBucket } from "../../../../../../utils/bucketAccess.js";
import { setAccessLog } from "../../../../../../middleware/accessLog.js";
import { validateUser } from "../../../../../../middleware/auth.js";
import { grantTx } from "../../../../../../utils/bucketGrants.js";
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

  const permission = await db.$transaction((tx) =>
    grantTx(
      tx,
      auth,
      bucket,
      body.userId,
      {
        canRead: body.canRead,
        canWrite: body.canWrite,
        canDelete: body.canDelete,
      },
      existing
    )
  );
  notifyBucketAccessChanged([permission.userId], bucket.name);

  const [serialized] = await serializePermissions([permission]);
  res.status(201).json(serialized);
};
