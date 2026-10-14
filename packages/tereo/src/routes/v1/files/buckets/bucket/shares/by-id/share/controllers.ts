import { setAccessLog } from "../../../../../../../../middleware/accessLog.js";
import { validateUser } from "../../../../../../../../middleware/auth.js";
import { hashPassword } from "../../../../../../../../utils/password.js";
import { shareIdParamSchema, updateShareBodySchema } from "./schemas.js";
import db from "../../../../../../../../utils/db/index.js";
import { Request, Response } from "express";
import {
  canWriteBucket,
  getAccessibleBucket,
  validateBucketAccess,
  validateBucketPermission,
} from "../../../../../../../../utils/bucketAccess.js";
import {
  validateBody,
  validateParams,
} from "../../../../../../../../utils/validateReq.js";
import {
  ConflictError,
  NotFoundError,
} from "../../../../../../../../utils/errors.js";
import {
  logAuditTx,
  computeChanges,
  emitTx,
} from "../../../../../../../../utils/outbox.js";
import {
  serializeShare,
  archiveExpiryFor,
  validateShareTtl,
} from "../../controllers.js";

/**
 * GET /buckets/:name/shares/by-id/:id
 */
export const getShare = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name, id } = validateParams(shareIdParamSchema, req);

  const bucket = await getAccessibleBucket(auth, name, "read");
  setAccessLog(res, { bucketId: bucket.id, operation: "GET_SHARE" });

  const share = await db.shares.get(id);
  if (share.bucketId !== bucket.id) {
    throw new NotFoundError("Share not found");
  }

  const revealToken =
    share.createdByUserId === auth.userId || (await canWriteBucket(auth, name));
  res.json(serializeShare(share, { revealToken }));
};

/**
 * PATCH /buckets/:name/shares/by-id/:id
 */
export const updateShare = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name, id } = validateParams(shareIdParamSchema, req);
  const body = validateBody(updateShareBodySchema, req);

  const bucket = await getAccessibleBucket(auth, name, "read");

  const existing = await db.shares.get(id);
  if (existing.bucketId !== bucket.id) {
    throw new NotFoundError("Share not found");
  }
  // Creator or a user with bucket write may edit; admins pass the check.
  // Permission only: shares go on in a retired bucket.
  if (existing.createdByUserId !== auth.userId) {
    await validateBucketPermission(auth, name, "write");
  }
  if (existing.revokedAt) {
    throw new ConflictError("Cannot update a revoked share", "share_revoked");
  }

  // `null` asks for the longest expiry allowed, from now: no share lives
  // forever.
  const expiresAt =
    "expiresAt" in body ? validateShareTtl(body.expiresAt) : undefined;

  const update: Parameters<typeof db.shares.update>[1] = {};
  if ("urlFilename" in body) update.urlFilename = body.urlFilename;
  if (expiresAt) update.expiresAt = expiresAt;
  if ("maxDownloads" in body) update.maxDownloads = body.maxDownloads;
  if ("note" in body) update.note = body.note;
  if ("password" in body) {
    update.passwordHash =
      body.password === null
        ? null
        : body.password
          ? await hashPassword(body.password)
          : null;
  }

  // An archive share serves its archive request, which expires on its own;
  // a later share expiry carries the archive along, as on create.
  const archiveExpiresAt =
    existing.kind === "ARCHIVE" && existing.archiveRequest && expiresAt
      ? archiveExpiryFor(expiresAt)
      : null;

  const updated = await db.$transaction(async (tx) => {
    if (
      archiveExpiresAt &&
      existing.archiveRequest &&
      archiveExpiresAt > existing.archiveRequest.expiresAt
    ) {
      await tx.archiveRequest.update({
        where: { id: existing.archiveRequest.id },
        data: { expiresAt: archiveExpiresAt },
      });
    }
    const next = await db.shares.update(id, update, tx);

    // Shallow before/after for audit log — exclude password fields.
    const before: Record<string, unknown> = {
      urlFilename: existing.urlFilename,
      expiresAt: existing.expiresAt,
      maxDownloads: existing.maxDownloads,
      note: existing.note,
      hasPassword: Boolean(existing.passwordHash),
    };
    const after: Record<string, unknown> = {
      urlFilename: next.urlFilename,
      expiresAt: next.expiresAt,
      maxDownloads: next.maxDownloads,
      note: next.note,
      hasPassword: Boolean(next.passwordHash),
    };
    await logAuditTx(tx, {
      auth,
      organizationId: bucket.organizationId ?? undefined,
      action: "UPDATE",
      entityType: "share",
      entityId: next.id,
      changes: computeChanges(before, after),
      metadata: { bucketName: bucket.name, kind: next.kind },
    });

    if (bucket.organizationId) {
      await emitTx(tx, {
        eventType: "file-service.share.updated",
        organizationId: bucket.organizationId,
        entityType: "share",
        entityId: next.id,
        data: { bucketName: bucket.name, kind: next.kind },
      });
    }

    return next;
  });

  setAccessLog(res, { bucketId: bucket.id, operation: "UPDATE_SHARE" });

  res.json(serializeShare(updated, { revealToken: true }));
};

/**
 * DELETE /buckets/:name/shares/by-id/:id — soft revoke.
 */
export const revokeShare = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name, id } = validateParams(shareIdParamSchema, req);

  const bucket = await getAccessibleBucket(auth, name, "read");

  const existing = await db.shares.get(id);
  if (existing.bucketId !== bucket.id) {
    throw new NotFoundError("Share not found");
  }
  if (existing.createdByUserId !== auth.userId) {
    await validateBucketAccess(auth, name, "delete");
  }
  if (existing.revokedAt) {
    // Idempotent — already revoked.
    res.status(204).send();
    return;
  }

  await db.$transaction(async (tx) => {
    // Only the first of two concurrent revokes is audited.
    if (!(await db.shares.revoke(id, auth.userId, tx))) return;

    await logAuditTx(tx, {
      auth,
      organizationId: bucket.organizationId ?? undefined,
      action: "DELETE",
      entityType: "share",
      entityId: id,
      metadata: { bucketName: bucket.name, kind: existing.kind },
    });

    if (bucket.organizationId) {
      await emitTx(tx, {
        eventType: "file-service.share.revoked",
        organizationId: bucket.organizationId,
        entityType: "share",
        entityId: id,
        data: { bucketName: bucket.name, kind: existing.kind },
      });
    }
  });

  setAccessLog(res, { bucketId: bucket.id, operation: "REVOKE_SHARE" });

  res.status(204).send();
};
