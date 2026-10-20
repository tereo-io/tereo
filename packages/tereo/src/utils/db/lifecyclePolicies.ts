import { Prisma } from "../../../prisma/generated/client/index.js";
import { prisma } from "./prisma.js";

export interface UpsertPolicyInput {
  bucketId: number;
  expireObjectsAfterDays?: number | null;
  expireVersionsAfterDays?: number | null;
  purgeSoftDeletedAfterDays?: number | null;
  enabled?: boolean;
}

export const getByBucket = async (bucketId: number) => {
  return await prisma.bucketLifecyclePolicy.findUnique({
    where: { bucketId },
  });
};

export const upsert = async (
  input: UpsertPolicyInput,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  return await client.bucketLifecyclePolicy.upsert({
    where: { bucketId: input.bucketId },
    create: {
      bucketId: input.bucketId,
      expireObjectsAfterDays: input.expireObjectsAfterDays ?? null,
      expireVersionsAfterDays: input.expireVersionsAfterDays ?? null,
      purgeSoftDeletedAfterDays: input.purgeSoftDeletedAfterDays ?? null,
      enabled: input.enabled ?? true,
    },
    update: {
      expireObjectsAfterDays: input.expireObjectsAfterDays ?? null,
      expireVersionsAfterDays: input.expireVersionsAfterDays ?? null,
      purgeSoftDeletedAfterDays: input.purgeSoftDeletedAfterDays ?? null,
      enabled: input.enabled ?? true,
    },
  });
};

export const remove = async (
  bucketId: number,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  const { count } = await client.bucketLifecyclePolicy.deleteMany({
    where: { bucketId },
  });
  return count > 0;
};

export const listEnabled = async () => {
  return await prisma.bucketLifecyclePolicy.findMany({
    where: {
      enabled: true,
      bucket: { deletedAt: null },
      // Skip no-op policies (all three *AfterDays NULL) — they have nothing
      // to sweep but would still enqueue a daily job per bucket.
      OR: [
        { expireObjectsAfterDays: { not: null } },
        { expireVersionsAfterDays: { not: null } },
        { purgeSoftDeletedAfterDays: { not: null } },
      ],
    },
    include: { bucket: true },
  });
};

/**
 * All `findXxx` helpers accept an optional `afterId` cursor. Pagination is by
 * primary key ascending: callers pass the max id they last processed and the
 * next call returns rows strictly greater than that. This is stable under
 * concurrent mutations (soft-deletes don't move prior rows) and cheap
 * (indexed PK lookup + small LIMIT).
 */

export const findObjectsPastExpiration = async (
  bucketId: number,
  days: number,
  limit: number,
  afterId?: string
) => {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return await prisma.object.findMany({
    where: {
      bucketId,
      deletedAt: null,
      // Age is counted from the last write (the current version), as S3
      // counts it, not from when the key was first created.
      versions: {
        some: { isCurrent: true, deletedAt: null, createdAt: { lt: cutoff } },
      },
      thumbnailFor: null,
      ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
    },
    take: limit,
    orderBy: { id: "asc" },
  });
};

export const findVersionsPastExpiration = async (
  bucketId: number,
  days: number,
  limit: number,
  afterId?: string
) => {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return await prisma.objectVersion.findMany({
    where: {
      deletedAt: null,
      isCurrent: false,
      // Counted from when a newer version replaced it, as S3's
      // NoncurrentDays is, not from its own upload.
      noncurrentSince: { lt: cutoff },
      object: { bucketId },
      ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
    },
    take: limit,
    orderBy: { id: "asc" },
    // Need `sizeBytes` so the sweep can refund bucket usage in the same tx
    // as the decRef. `current_usage_bytes` counts every retained blob ref —
    // dropping a ref without decrementing leaves the counter inflated.
    include: { contentBlob: { select: { sizeBytes: true } } },
  });
};

export const findSoftDeletedObjectsPastPurge = async (
  bucketId: number,
  days: number,
  limit: number,
  afterId?: string
) => {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return await prisma.object.findMany({
    where: {
      bucketId,
      deletedAt: { lt: cutoff },
      ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
    },
    take: limit,
    orderBy: { id: "asc" },
  });
};

export const findExpiredDeleteAfter = async (
  limit: number,
  afterId?: string
) => {
  return await prisma.object.findMany({
    where: {
      deletedAt: null,
      deleteAfter: { lt: new Date() },
      ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
    },
    take: limit,
    orderBy: { id: "asc" },
  });
};
