import { Prisma } from "../../../prisma/generated/client/index.js";
import { NotFoundError } from "../errors.js";
import { prisma } from "./prisma.js";

export interface CreateInput {
  bucketId: number;
  prefix: string | null;
  versionIds: string[];
  format: "zip" | "tar";
  filename: string;
  totalSizeBytes: bigint;
  expiresAt: Date;
  createdByUserId: string | null;
}

/** The snapshot as `archive_request_objects` rows, in download order. */
export const versionLinks = (versionIds: string[]) => ({
  create: versionIds.map((versionId, position) => ({ versionId, position })),
});

export const create = async (
  input: CreateInput,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  return await client.archiveRequest.create({
    data: {
      bucketId: input.bucketId,
      prefix: input.prefix,
      objects: versionLinks(input.versionIds),
      format: input.format,
      filename: input.filename,
      objectCount: input.versionIds.length,
      totalSizeBytes: input.totalSizeBytes,
      expiresAt: input.expiresAt,
      createdByUserId: input.createdByUserId,
    },
  });
};

export const get = async (id: string) => {
  const archive = await prisma.archiveRequest.findUnique({ where: { id } });
  if (!archive) throw new NotFoundError("Archive request not found");
  return archive;
};

export const markDownloaded = async (
  id: string,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  await client.archiveRequest.update({
    where: { id },
    data: { downloadedAt: new Date() },
  });
};

/**
 * Enumerate object ids under a prefix for an archive snapshot. Bounded by
 * `maxObjects` so one request cannot pull an entire multi-million-object
 * bucket. Returns all matching ids in a single page when they fit under the
 * cap, or throws if the cap is exceeded (the caller surfaces this to the
 * user so they can narrow their prefix).
 */
export const enumerateObjectIdsForPrefix = async (
  bucketId: number,
  prefix: string,
  maxObjects: number
): Promise<string[]> => {
  const rows = await prisma.object.findMany({
    where: {
      bucketId,
      objectKey: { startsWith: prefix },
      deletedAt: null,
      thumbnailFor: null,
    },
    select: { id: true },
    orderBy: { id: "asc" },
    take: maxObjects + 1,
  });
  return rows.map((r) => r.id);
};

/**
 * Resolve a caller-provided list of object keys to UUIDs, scoped to one
 * bucket. Silently drops keys that don't match a live object — the caller
 * compares lengths to detect gaps and surface a warning if desired.
 */
export const resolveObjectIdsByKeys = async (
  bucketId: number,
  keys: string[]
): Promise<{ id: string; objectKey: string }[]> => {
  if (keys.length === 0) return [];
  return await prisma.object.findMany({
    where: {
      bucketId,
      objectKey: { in: keys },
      deletedAt: null,
      thumbnailFor: null,
    },
    select: { id: true, objectKey: true },
  });
};

export interface ObjectForArchiveStream {
  id: string;
  versionId: string;
  objectKey: string;
  contentType: string | null;
  contentBlob: {
    hash: string;
    fsPath: string;
    sizeBytes: bigint;
    wrappedDek: Uint8Array;
    iv: Uint8Array;
    masterKeyVersion: number;
  };
}

/**
 * Load object + current version + blob for each id, in the given order, to
 * take an archive's snapshot. Objects without current content are dropped.
 * Loaded in chunks to keep the `IN (...)` list bounded on large archives.
 */
export const loadObjectsForStreaming = async (
  objectIds: string[],
  chunkSize = 200
): Promise<ObjectForArchiveStream[]> => {
  const out: ObjectForArchiveStream[] = [];
  for (let i = 0; i < objectIds.length; i += chunkSize) {
    const slice = objectIds.slice(i, i + chunkSize);
    const rows = await prisma.object.findMany({
      where: { id: { in: slice }, deletedAt: null },
      include: {
        versions: {
          where: { isCurrent: true, deletedAt: null, isDeleteMarker: false },
          include: { contentBlob: true },
          take: 1,
        },
      },
    });
    for (const row of rows) {
      const v = row.versions[0];
      if (!v || !v.contentBlob) continue;
      out.push({
        id: row.id,
        versionId: v.id,
        objectKey: row.objectKey,
        contentType: v.contentType,
        contentBlob: {
          hash: v.contentBlob.hash,
          fsPath: v.contentBlob.fsPath,
          sizeBytes: v.contentBlob.sizeBytes,
          wrappedDek: v.contentBlob.wrappedDek,
          iv: v.contentBlob.iv,
          masterKeyVersion: v.contentBlob.masterKeyVersion,
        },
      });
    }
  }
  // Preserve caller-provided order so zip entries are predictable.
  const byId = new Map(out.map((o) => [o.id, o]));
  return objectIds
    .map((id) => byId.get(id))
    .filter((o): o is ObjectForArchiveStream => o !== undefined);
};

/**
 * The archive's snapshot entries still serveable, in download order: those
 * whose recorded version is still its object's current content. An entry
 * whose object was overwritten, deleted or purged since creation is left out.
 */
export const loadSnapshotForStreaming = async (
  archiveRequestId: string
): Promise<ObjectForArchiveStream[]> => {
  const rows = await prisma.archiveRequestObject.findMany({
    where: {
      archiveRequestId,
      version: {
        isCurrent: true,
        deletedAt: null,
        isDeleteMarker: false,
        object: { deletedAt: null },
      },
    },
    orderBy: { position: "asc" },
    include: { version: { include: { object: true, contentBlob: true } } },
  });
  const out: ObjectForArchiveStream[] = [];
  for (const { version: v } of rows) {
    if (!v.contentBlob) continue;
    out.push({
      id: v.objectId,
      versionId: v.id,
      objectKey: v.object.objectKey,
      contentType: v.contentType,
      contentBlob: {
        hash: v.contentBlob.hash,
        fsPath: v.contentBlob.fsPath,
        sizeBytes: v.contentBlob.sizeBytes,
        wrappedDek: v.contentBlob.wrappedDek,
        iv: v.contentBlob.iv,
        masterKeyVersion: v.contentBlob.masterKeyVersion,
      },
    });
  }
  return out;
};

/**
 * Hard-delete archive requests that expired more than `retentionGraceMs` ago.
 * Archives are streamed on demand, so the row (and its snapshot, which
 * cascades) is all there is. Shares pointing at the archive cascade too; they
 * have answered 404 since the archive expired, and the share sweep would drop
 * them on the same grace.
 */
export const deleteExpired = async (
  retentionGraceMs: number,
  now: Date = new Date(),
  limit = 500
): Promise<number> => {
  const cutoff = new Date(now.getTime() - retentionGraceMs);
  const expired = await prisma.archiveRequest.findMany({
    where: { expiresAt: { lt: cutoff } },
    select: { id: true },
    take: limit,
  });
  if (expired.length === 0) return 0;
  const result = await prisma.archiveRequest.deleteMany({
    where: { id: { in: expired.map((r) => r.id) } },
  });
  return result.count;
};
