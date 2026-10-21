import { NotFoundError } from "../errors.js";
import { userRefSelect } from "../refs.js";
import { prisma } from "./prisma.js";
import {
  Prisma,
  ShareKind,
  Share,
} from "../../../prisma/generated/client/index.js";

export interface CreateShareInput {
  token: string;
  bucketId: number;
  kind: ShareKind;
  objectId?: string | null;
  versionId?: string | null;
  archiveRequestId?: string | null;
  urlFilename?: string | null;
  passwordHash?: string | null;
  expiresAt?: Date | null;
  maxDownloads?: number | null;
  note?: string | null;
  createdByUserId: string;
}

export interface UpdateShareInput {
  urlFilename?: string | null;
  passwordHash?: string | null;
  expiresAt?: Date | null;
  maxDownloads?: number | null;
  note?: string | null;
}

export interface GetPaginatedOptions {
  bucketId: number;
  take: number;
  orderBy?: Prisma.ShareOrderByWithRelationInput[];
  where?: Prisma.ShareWhereInput;
}

const includeTargets = {
  object: { select: { id: true, objectKey: true, bucketId: true } },
  version: { select: { id: true, objectId: true, isCurrent: true } },
  archiveRequest: {
    select: {
      id: true,
      bucketId: true,
      prefix: true,
      format: true,
      filename: true,
      objectCount: true,
      totalSizeBytes: true,
      expiresAt: true,
    },
  },
  // `isActive`: a deactivated creator's shares stop serving.
  creator: { select: { ...userRefSelect.select, isActive: true } },
  revoker: userRefSelect,
} satisfies Prisma.ShareInclude;

export const create = async (
  input: CreateShareInput,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  return await client.share.create({
    data: {
      token: input.token,
      bucketId: input.bucketId,
      kind: input.kind,
      objectId: input.objectId ?? null,
      versionId: input.versionId ?? null,
      archiveRequestId: input.archiveRequestId ?? null,
      urlFilename: input.urlFilename ?? null,
      passwordHash: input.passwordHash ?? null,
      expiresAt: input.expiresAt ?? null,
      maxDownloads: input.maxDownloads ?? null,
      note: input.note ?? null,
      createdByUserId: input.createdByUserId,
    },
    include: includeTargets,
  });
};

export const get = async (id: string) => {
  const share = await prisma.share.findUnique({
    where: { id },
    include: includeTargets,
  });
  if (!share) throw new NotFoundError("Share not found");
  return share;
};

/** Fetch the share row by token, with only its creator's `isActive`. Public-
 * route callers do kind-aware target resolution (`getLiveObjectTarget` /
 * `getLiveArchiveTarget`) so a single by-token lookup never LEFT-JOINs the
 * two unused target tables. */
export const getByTokenRaw = async (token: string) => {
  return await prisma.share.findUnique({
    where: { token },
    include: { creator: { select: { isActive: true } } },
  });
};

/** OBJECT-share target resolver. Returns null when the object (or pinned
 * version) is soft-deleted / a delete-marker, so a share to a tombstoned
 * target maps to uniform 404 *before* the download counter is incremented. */
export const getLiveObjectTarget = async (
  objectId: string,
  versionId: string | null
): Promise<{ id: string; objectKey: string; bucketId: number } | null> => {
  const object = await prisma.object.findFirst({
    where: { id: objectId, deletedAt: null, thumbnailFor: null },
    select: { id: true, objectKey: true, bucketId: true },
  });
  if (!object) return null;
  if (versionId) {
    const version = await prisma.objectVersion.findFirst({
      where: {
        id: versionId,
        objectId,
        deletedAt: null,
        isDeleteMarker: false,
      },
      select: { id: true },
    });
    if (!version) return null;
  }
  return object;
};

/** ARCHIVE-share target resolver. Returns null when the archive request has
 * expired or been pruned, which its signed download would refuse after the
 * share had counted the download (the archive's expiry follows the share's,
 * so this should be vanishingly rare in practice). */
export const getLiveArchiveTarget = async (
  archiveRequestId: string
): Promise<{ id: string; filename: string; format: string } | null> => {
  return await prisma.archiveRequest.findFirst({
    where: { id: archiveRequestId, expiresAt: { gt: new Date() } },
    select: { id: true, filename: true, format: true },
  });
};

/** Content type and size of the version an OBJECT share serves — the pinned
 * version, else the current one. Only the status probe needs these, so they
 * are kept out of `getLiveObjectTarget`, which every download runs. */
export const getObjectTargetDetails = async (
  objectId: string,
  versionId: string | null
): Promise<{ contentType: string | null; sizeBytes: bigint | null }> => {
  const version = await prisma.objectVersion.findFirst({
    where: versionId
      ? { id: versionId, objectId }
      : { objectId, isCurrent: true, deletedAt: null },
    select: { contentType: true, contentBlob: { select: { sizeBytes: true } } },
  });
  return {
    contentType: version?.contentType ?? null,
    sizeBytes: version?.contentBlob?.sizeBytes ?? null,
  };
};

/**
 * For a signed URL minted from a share: null when the share no longer serves
 * (a deactivated creator's included); otherwise whether it has a download
 * cap, whose URLs are single-use.
 */
export const getServeableShare = async (
  id: string
): Promise<{ capped: boolean } | null> => {
  const share = await prisma.share.findUnique({
    where: { id },
    select: {
      revokedAt: true,
      expiresAt: true,
      maxDownloads: true,
      downloadCount: true,
      creator: { select: { isActive: true } },
    },
  });
  if (!share) return null;
  if (share.revokedAt || !share.creator.isActive) return null;
  if (share.expiresAt && share.expiresAt.getTime() < Date.now()) return null;
  if (share.maxDownloads !== null && share.downloadCount > share.maxDownloads) {
    return null;
  }
  return { capped: share.maxDownloads !== null };
};

export const update = async (
  id: string,
  data: UpdateShareInput,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  return await client.share.update({
    where: { id },
    data,
    include: includeTargets,
  });
};

/** False when the share was already revoked (by a concurrent revoke). */
export const revoke = async (
  id: string,
  revokedByUserId: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const client = tx ?? prisma;
  const { count } = await client.share.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date(), revokedByUserId },
  });
  return count > 0;
};

/**
 * The shares `userId` created that still serve (not revoked or expired), on
 * one bucket or on every live bucket of an organization.
 */
export const getActiveByCreator = async (
  scope: { userId: string } & (
    { bucketId: number } | { organizationId: string }
  ),
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  return await client.share.findMany({
    where: {
      createdByUserId: scope.userId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      bucket:
        "bucketId" in scope
          ? { id: scope.bucketId }
          : { organizationId: scope.organizationId, deletedAt: null },
    },
    select: {
      id: true,
      kind: true,
      bucket: { select: { name: true, organizationId: true, serviceId: true } },
    },
    orderBy: { createdAt: "asc" },
  });
};

/**
 * Atomic check-and-increment. Returns the updated Share when the download was
 * permitted, null when the cap is already saturated. Concurrent downloads race
 * safely: maxDownloads=3 + 20 parallel calls = exactly 3 successes.
 */
export const atomicIncrementDownloads = async (
  id: string,
  tx?: Prisma.TransactionClient
): Promise<Share | null> => {
  const client = tx ?? prisma;
  const rows = await client.$queryRaw<Share[]>`
    UPDATE "files"."shares"
    SET download_count = download_count + 1, updated_at = NOW()
    WHERE id = ${id}::uuid
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > NOW())
      AND (max_downloads IS NULL OR download_count < max_downloads)
    RETURNING *
  `;
  return rows[0] ?? null;
};

export const getPaginated = async (options: GetPaginatedOptions) => {
  const { bucketId, take, orderBy, where: filterWhere } = options;

  const where: Prisma.ShareWhereInput = filterWhere
    ? { AND: [{ bucketId }, filterWhere] }
    : { bucketId };

  const rows = await prisma.share.findMany({
    where,
    take: take + 1,
    orderBy: orderBy ?? [{ createdAt: "desc" }],
    include: includeTargets,
  });

  const hasMore = rows.length > take;
  const data = hasMore ? rows.slice(0, take) : rows;
  return { data, hasMore };
};

/**
 * Give every share without an expiry the longest one allowed, counted from its
 * creation. Shares created before expiries were required have none; the
 * `expires_at` index makes this a no-op lookup once they are filled. Returns
 * the shares it gave one.
 */
export const backfillExpiry = async (
  maxTtlSeconds: number,
  tx: Prisma.TransactionClient
): Promise<{ id: string; bucketId: number; expiresAt: Date }[]> =>
  await tx.$queryRaw`
    UPDATE "files"."shares"
    SET expires_at = created_at + make_interval(secs => ${maxTtlSeconds}::double precision),
        updated_at = now()
    WHERE expires_at IS NULL
    RETURNING id, bucket_id AS "bucketId", expires_at AS "expiresAt"`;

/**
 * Hard-delete share rows whose audit value has lapsed: revoked or expired
 * for longer than `retentionGraceMs`. The audit trail itself lives in
 * the audit log and is unaffected — we only drop the local row that
 * cannot serve another download. Bounded by `limit` per call; the share-
 * sweep worker calls this in a loop until the batch is empty, and audits
 * what it deleted in the same transaction. Returns the deleted rows.
 */
export const deleteExpired = async (
  retentionGraceMs: number,
  now: Date,
  limit: number,
  tx: Prisma.TransactionClient
) => {
  const cutoff = new Date(now.getTime() - retentionGraceMs);
  const expired = await tx.share.findMany({
    where: {
      OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
    },
    select: {
      id: true,
      kind: true,
      bucket: { select: { id: true, name: true, organizationId: true } },
    },
    take: limit,
  });
  if (expired.length === 0) return [];
  await tx.share.deleteMany({
    where: { id: { in: expired.map((r) => r.id) } },
  });
  return expired;
};
