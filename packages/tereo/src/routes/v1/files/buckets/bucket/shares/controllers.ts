import { setAccessLog } from "../../../../../../middleware/accessLog.js";
import { logAuditTx, emitTx } from "../../../../../../utils/outbox.js";
import { validateUser } from "../../../../../../middleware/auth.js";
import { hashPassword } from "../../../../../../utils/password.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { toUserRef } from "../../../../../../utils/refs.js";
import db from "../../../../../../utils/db/index.js";
import { bucketNameSchema } from "../../schemas.js";
import { Request, Response } from "express";
import env from "../../../../../../env.js";
import { randomBytes } from "crypto";
import {
  Prisma,
  ShareKind,
} from "../../../../../../../prisma/generated/client/index.js";
import {
  canWriteBucket,
  getAccessibleBucket,
} from "../../../../../../utils/bucketAccess.js";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../../../../../../utils/validateReq.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../../../utils/errors.js";
import {
  applyCursorToWhere,
  encodeListCursor,
} from "../../../../../../utils/cursor.js";
import {
  createShareBodySchema,
  listSharesQuerySchema,
  type CreateArchiveShareBody,
  type CreateObjectShareBody,
} from "./schemas.js";

type ShareWithTargets = Awaited<ReturnType<typeof db.shares.get>>;

const ARCHIVE_FILENAME_FALLBACK = "archive";

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateToken(): string {
  return base64UrlEncode(
    randomBytes(env.FILE_SERVICE_SHARE_DEFAULT_TOKEN_BYTES)
  );
}

/**
 * Render the public URL we hand to recipients. Always points at the file-
 * service so automated clients can `POST /shared/:token/unlock` directly
 * against the returned URL's host. Browsers hitting a password-protected
 * share are transparently forwarded to the admin UI by content-negotiation
 * in `routes/v1/files/shared/share/controllers.ts` (see `FILE_SERVICE_SHARE_UI_BASE_URL`).
 */
function renderShareUrl(token: string, urlFilename: string | null): string {
  const base = env.FILE_SERVICE_PUBLIC_BASE_URL.replace(/\/+$/, "");
  const suffix = urlFilename ? `/${encodeURIComponent(urlFilename)}` : "";
  return `${base}/shared/${encodeURIComponent(token)}${suffix}`;
}

function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex -- intentionally strips control chars that break Content-Disposition / filesystems
  const cleaned = name.replace(/[\x00-\x1f/\\]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : ARCHIVE_FILENAME_FALLBACK;
}

function deriveArchiveFilename(
  prefix: string | undefined,
  format: string
): string {
  if (!prefix) return `${ARCHIVE_FILENAME_FALLBACK}.${format}`;
  const trimmed = prefix.replace(/\/+$/, "");
  const last = trimmed.split("/").filter(Boolean).pop();
  return `${last ?? ARCHIVE_FILENAME_FALLBACK}.${format}`;
}

function deriveDefaultUrlFilename(share: ShareWithTargets): string | null {
  if (share.kind === "OBJECT" && share.object) {
    const basename = share.object.objectKey.split("/").pop();
    return basename && basename.length > 0 ? basename : null;
  }
  if (share.kind === "ARCHIVE" && share.archiveRequest) {
    return share.archiveRequest.filename ?? null;
  }
  return null;
}

function shareStatus(
  share: ShareWithTargets
): "active" | "revoked" | "expired" | "exhausted" {
  if (share.revokedAt) return "revoked";
  if (share.expiresAt && share.expiresAt.getTime() < Date.now())
    return "expired";
  if (
    share.maxDownloads !== null &&
    share.downloadCount >= share.maxDownloads
  ) {
    return "exhausted";
  }
  return "active";
}

/**
 * `revealToken` decides whether the token and its URL are included: the
 * share's creator and the bucket's writers see them, other readers get null.
 */
export function serializeShare(
  share: ShareWithTargets,
  { revealToken }: { revealToken: boolean }
) {
  const effectiveUrlFilename =
    share.urlFilename ?? deriveDefaultUrlFilename(share);
  return {
    id: share.id,
    token: revealToken ? share.token : null,
    bucketId: share.bucketId,
    kind: share.kind,
    url: revealToken ? renderShareUrl(share.token, effectiveUrlFilename) : null,
    urlFilename: share.urlFilename,
    objectId: share.objectId,
    versionId: share.versionId,
    archiveRequestId: share.archiveRequestId,
    hasPassword: Boolean(share.passwordHash),
    expiresAt: share.expiresAt?.toISOString() ?? null,
    maxDownloads: share.maxDownloads,
    downloadCount: share.downloadCount,
    revokedAt: share.revokedAt?.toISOString() ?? null,
    revokedByUserId: share.revokedByUserId,
    revokedByUser: toUserRef(share.revoker),
    note: share.note,
    createdByUserId: share.createdByUserId,
    creator: toUserRef(share.creator),
    createdAt: share.createdAt.toISOString(),
    updatedAt: share.updatedAt.toISOString(),
    status: shareStatus(share),
    object: share.object
      ? {
          id: share.object.id,
          objectKey: share.object.objectKey,
        }
      : null,
    archiveRequest: share.archiveRequest
      ? {
          id: share.archiveRequest.id,
          prefix: share.archiveRequest.prefix,
          format: share.archiveRequest.format,
          filename: share.archiveRequest.filename,
          objectCount: share.archiveRequest.objectCount,
          totalSizeBytes: share.archiveRequest.totalSizeBytes.toString(),
          expiresAt: share.archiveRequest.expiresAt.toISOString(),
        }
      : null,
  };
}

/**
 * The archive's own expiry must extend beyond the share's — otherwise the
 * share could outlive the content it points at. The share's expiry plus a
 * small grace.
 */
export function archiveExpiryFor(shareExpiresAt: Date): Date {
  return new Date(shareExpiresAt.getTime() + 60_000);
}

/**
 * The expiry a share gets: `expiresAt` once checked to be in the future and
 * within FILE_SERVICE_MAX_SHARE_TTL_SECONDS, or that cap from now when none
 * is given. No share lives forever.
 */
export function validateShareTtl(expiresAt: Date | null | undefined): Date {
  const max = env.FILE_SERVICE_MAX_SHARE_TTL_SECONDS * 1000;
  if (!expiresAt) return new Date(Date.now() + max);
  const delta = expiresAt.getTime() - Date.now();
  if (delta <= 0) {
    throw new BadRequestError(
      "invalid_expiration",
      "expiresAt must be in the future"
    );
  }
  if (delta > max) {
    throw new BadRequestError(
      "invalid_expiration",
      `expiresAt must be within ${env.FILE_SERVICE_MAX_SHARE_TTL_SECONDS} seconds from now`
    );
  }
  return expiresAt;
}

/**
 * POST /buckets/:name/shares
 */
export const createShare = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name } = validateParams(bucketNameSchema, req);
  const body = validateBody(createShareBodySchema, req);

  const bucket = await getAccessibleBucket(auth, name, "read");

  const expiresAt = validateShareTtl(body.expiresAt);

  // Random 18-byte token collides with probability ~0; if the unique-constraint
  // path ever fires the child create helpers map P2002 to ConflictError and the
  // caller can retry.
  const token = generateToken();
  const passwordHash = body.password ? await hashPassword(body.password) : null;

  // OBJECT-share validation work that doesn't need to be in the transaction
  // (object existence + version-belongs-to-object). For ARCHIVE shares, the
  // resolution / size-cap checks happen in `prepareArchiveShare` below.
  let prepared:
    | {
        kind: "OBJECT";
        objectId: string;
        versionId: string | null;
      }
    | {
        kind: "ARCHIVE";
        versionIds: string[];
        totalBytes: bigint;
        archiveExpiresAt: Date;
        filename: string;
      };
  if (body.kind === "OBJECT") {
    prepared = await prepareObjectShare(bucket, body);
  } else {
    prepared = await prepareArchiveShare(bucket, body, expiresAt);
  }

  const share = await db.$transaction(async (tx) => {
    let created: ShareWithTargets;
    try {
      if (prepared.kind === "OBJECT") {
        created = await db.shares.create(
          {
            token,
            bucketId: bucket.id,
            kind: "OBJECT" as ShareKind,
            objectId: prepared.objectId,
            versionId: prepared.versionId,
            urlFilename: body.urlFilename ?? null,
            passwordHash,
            expiresAt,
            maxDownloads: body.maxDownloads ?? null,
            note: body.note ?? null,
            createdByUserId: auth.userId,
          },
          tx
        );
      } else {
        const archive = await tx.archiveRequest.create({
          data: {
            bucketId: bucket.id,
            prefix:
              body.kind === "ARCHIVE" && body.prefix !== undefined
                ? body.prefix
                : null,
            objects: db.archives.versionLinks(prepared.versionIds),
            format: (body as CreateArchiveShareBody).format,
            filename: prepared.filename,
            objectCount: prepared.versionIds.length,
            totalSizeBytes: prepared.totalBytes,
            expiresAt: prepared.archiveExpiresAt,
            createdByUserId: auth.userId,
          },
        });
        created = await db.shares.create(
          {
            token,
            bucketId: bucket.id,
            kind: "ARCHIVE" as ShareKind,
            archiveRequestId: archive.id,
            urlFilename: body.urlFilename ?? null,
            passwordHash,
            expiresAt,
            maxDownloads: body.maxDownloads ?? null,
            note: body.note ?? null,
            createdByUserId: auth.userId,
          },
          tx
        );
      }
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new ConflictError("Share slug collision; retry");
      }
      throw err;
    }

    await logAuditTx(tx, {
      auth,
      organizationId: bucket.organizationId ?? undefined,
      action: "CREATE",
      entityType: "share",
      entityId: created.id,
      entityName: created.object?.objectKey ?? created.archiveRequest?.filename,
      metadata: {
        bucketName: bucket.name,
        kind: created.kind,
        objectId: created.objectId,
        versionId: created.versionId,
        archiveRequestId: created.archiveRequestId,
        hasPassword: Boolean(created.passwordHash),
        expiresAt: created.expiresAt?.toISOString() ?? null,
        maxDownloads: created.maxDownloads,
      },
    });

    if (bucket.organizationId) {
      await emitTx(tx, {
        eventType: "file-service.share.created",
        organizationId: bucket.organizationId,
        entityType: "share",
        entityId: created.id,
        data: {
          bucketName: bucket.name,
          kind: created.kind,
          objectId: created.objectId,
          archiveRequestId: created.archiveRequestId,
        },
      });
    }

    return created;
  });

  setAccessLog(res, {
    bucketId: bucket.id,
    operation: "CREATE_SHARE",
  });

  res.status(201).json(serializeShare(share, { revealToken: true }));
};

/**
 * Validate the OBJECT share inputs (object exists + belongs to bucket; pinned
 * version exists). Returns the resolved ids the controller's transaction will
 * persist.
 */
async function prepareObjectShare(
  bucket: Awaited<ReturnType<typeof db.buckets.getByName>>,
  body: CreateObjectShareBody
): Promise<{ kind: "OBJECT"; objectId: string; versionId: string | null }> {
  // Verify the object belongs to the bucket; getById throws NotFoundError
  // if it doesn't. This also prevents creating a share referencing a
  // soft-deleted object.
  const object = await db.objects.getById(bucket.id, body.objectId);

  if (body.versionId) {
    const version = await prisma.objectVersion.findFirst({
      where: {
        id: body.versionId,
        objectId: object.id,
        deletedAt: null,
      },
      select: { id: true, isDeleteMarker: true },
    });
    if (!version) {
      throw new NotFoundError(
        "Version not found or does not belong to this object"
      );
    }
    // A delete marker has no content, so its link could only ever 404.
    if (version.isDeleteMarker) {
      throw new BadRequestError(
        "cannot_share_delete_marker",
        "A delete marker has no content to share"
      );
    }
  }

  return {
    kind: "OBJECT",
    objectId: object.id,
    versionId: body.versionId ?? null,
  };
}

/**
 * Resolve and validate ARCHIVE share inputs (prefix or keys → object id list,
 * size-cap check, derived filename + archive-row TTL). Returns the prepared
 * values; the controller's transaction inserts the archive_request + share
 * rows + outbox publishes atomically.
 */
async function prepareArchiveShare(
  bucket: Awaited<ReturnType<typeof db.buckets.getByName>>,
  body: CreateArchiveShareBody,
  shareExpiresAt: Date
): Promise<{
  kind: "ARCHIVE";
  versionIds: string[];
  totalBytes: bigint;
  archiveExpiresAt: Date;
  filename: string;
}> {
  const maxObjects = env.FILE_SERVICE_MAX_ARCHIVE_OBJECTS;

  let objectIds: string[];
  if (body.prefix !== undefined) {
    const ids = await db.archives.enumerateObjectIdsForPrefix(
      bucket.id,
      body.prefix,
      maxObjects
    );
    if (ids.length > maxObjects) {
      throw new BadRequestError(
        "archive_too_large",
        `Prefix matches more than ${maxObjects} objects. Narrow the prefix or request individual keys.`
      );
    }
    objectIds = ids;
  } else {
    const resolved = await db.archives.resolveObjectIdsByKeys(
      bucket.id,
      body.keys ?? []
    );
    objectIds = resolved.map((r) => r.id);
  }

  const loaded = await db.archives.loadObjectsForStreaming(objectIds);
  if (loaded.length === 0) {
    throw new BadRequestError(
      "archive_empty",
      body.prefix !== undefined
        ? `No objects matched prefix "${body.prefix}"`
        : "None of the provided keys matched a live object"
    );
  }

  const totalBytes = loaded.reduce(
    (sum, o) => sum + o.contentBlob.sizeBytes,
    0n
  );
  const maxBytes = BigInt(env.FILE_SERVICE_MAX_ARCHIVE_TOTAL_BYTES);
  if (totalBytes > maxBytes) {
    throw new BadRequestError(
      "archive_too_large",
      `Archive would exceed ${env.FILE_SERVICE_MAX_ARCHIVE_TOTAL_BYTES} bytes. Narrow the selection.`
    );
  }

  const archiveExpiresAt = archiveExpiryFor(shareExpiresAt);
  const filename = sanitizeFilename(
    body.archiveFilename ?? deriveArchiveFilename(body.prefix, body.format)
  );

  return {
    kind: "ARCHIVE",
    versionIds: loaded.map((o) => o.versionId),
    totalBytes,
    archiveExpiresAt,
    filename,
  };
}

/**
 * GET /buckets/:name/shares
 */
export const listShares = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name } = validateParams(bucketNameSchema, req);
  const query = validateQuery(listSharesQuerySchema, req);

  const bucket = await getAccessibleBucket(auth, name, "read");
  setAccessLog(res, { bucketId: bucket.id, operation: "LIST_SHARES" });

  const where = applyCursorToWhere(query) as Prisma.ShareWhereInput;

  const result = await db.shares.getPaginated({
    bucketId: bucket.id,
    take: query.limit,
    orderBy: query.orderBy as Prisma.ShareOrderByWithRelationInput[],
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

  const isWriter = await canWriteBucket(auth, name);
  res.json({
    data: result.data.map((share) =>
      serializeShare(share, {
        revealToken: isWriter || share.createdByUserId === auth.userId,
      })
    ),
    hasMore: result.hasMore,
    limit: query.limit,
    nextCursor,
  });
};
