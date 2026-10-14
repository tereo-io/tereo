import { Prisma } from "../../../prisma/generated/client/index.js";
import { NotFoundError } from "../errors.js";
import { prisma } from "./prisma.js";
import {
  deleteBlobFile,
  discardStagedFile,
  placeBlobFile,
} from "../storage.js";

export interface UpsertContentBlobInput {
  hash: string;
  sizeBytes: bigint;
  fsPath: string;
  wrappedDek: Buffer;
  iv: Buffer;
  masterKeyVersion: number;
}

export const getByHash = async (
  hash: string,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  return await client.contentBlob.findUnique({ where: { hash } });
};

export const requireByHash = async (
  hash: string,
  tx?: Prisma.TransactionClient
) => {
  const blob = await getByHash(hash, tx);
  if (!blob) throw new NotFoundError("Content blob not found");
  return blob;
};

/**
 * The lock every writer of a blob's file holds, until its transaction ends:
 * `attach` from before it decides whose file the row points at until it
 * commits, and orphan cleanup around unlinking the file. A transaction-level
 * advisory lock, since the row may not exist yet.
 */
export const lockHash = async (
  hash: string,
  tx: Prisma.TransactionClient
): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`files:blob:${hash}`}, 0))`;
};

/**
 * Attach a write to the content-addressed `ContentBlob` for `input.hash`,
 * creating the row if there is none. Does not modify refCount — callers
 * call incRef in the same transaction.
 *
 * Writers of the same content serialize on `lockHash`, so the first to
 * attach creates the row and later ones (concurrent or not) find it:
 *
 * - **Created here**: the row takes this write's key material and the staged
 *   file is moved to `fsPath` (`placeBlobFile`), replacing any file there —
 *   with no row, no reader uses it.
 * - **Already there**: the row keeps its key material, which the file on disk
 *   was encrypted under, and the staged file is dropped. `orphaned_at` is
 *   cleared in the same statement, so a re-upload revives an orphan.
 *
 * `ON CONFLICT DO UPDATE` also waits on orphan cleanup's row lock
 * (`claimOrphan`): once cleanup deletes the row, this write creates it
 * afresh, and cleanup's unlink — taken under `lockHash` — sees the new row
 * and leaves the file alone.
 */
export const attach = async (
  input: UpsertContentBlobInput & { stagedPath: string },
  tx: Prisma.TransactionClient
): Promise<{ created: boolean }> => {
  await lockHash(input.hash, tx);
  const wrappedDek = Buffer.from(input.wrappedDek);
  const iv = Buffer.from(input.iv);
  const rows = await tx.$queryRaw<{ created: boolean }[]>`
    INSERT INTO "files"."content_blobs" (
      "hash",
      "size_bytes",
      "fs_path",
      "wrapped_dek",
      "iv",
      "master_key_version",
      "ref_count",
      "created_at"
    )
    VALUES (
      ${input.hash},
      ${input.sizeBytes}::bigint,
      ${input.fsPath},
      ${wrappedDek}::bytea,
      ${iv}::bytea,
      ${input.masterKeyVersion},
      0,
      NOW()
    )
    ON CONFLICT ("hash") DO UPDATE SET
      "orphaned_at" = NULL
    RETURNING ("xmax" = 0) AS "created"
  `;
  const created = rows[0]?.created === true;
  if (created) {
    await placeBlobFile(input.stagedPath, input.fsPath);
  } else {
    await discardStagedFile(input.stagedPath);
  }
  return { created };
};

/**
 * Clean up after a write whose transaction failed: drop its staged file and,
 * if no row now stands for the blob, the file at its content address (one
 * the failed write may have placed). Under `lockHash`, so a writer that is
 * creating the row has either placed its file and committed — the row is
 * seen — or not started.
 */
export const releaseStaged = async (blob: {
  hash: string;
  fsPath: string;
  stagedPath: string;
}): Promise<void> => {
  await discardStagedFile(blob.stagedPath);
  await prisma.$transaction(async (tx) => {
    await lockHash(blob.hash, tx);
    const row = await tx.contentBlob.findUnique({
      where: { hash: blob.hash },
      select: { hash: true },
    });
    if (!row) await deleteBlobFile(blob.fsPath);
  });
};

/**
 * Increment refCount on a blob atomically. Clears orphanedAt if previously set.
 * Must be called within a transaction that has already called upsert().
 */
export const incRef = async (
  hash: string,
  tx: Prisma.TransactionClient
): Promise<number> => {
  const rows = await tx.$queryRaw<{ ref_count: number }[]>`
    UPDATE "files"."content_blobs"
    SET "ref_count" = "ref_count" + 1,
        "orphaned_at" = NULL
    WHERE "hash" = ${hash}
    RETURNING "ref_count"
  `;
  if (rows.length === 0) {
    throw new NotFoundError("Content blob not found");
  }
  return rows[0].ref_count;
};

/**
 * Decrement refCount on a blob atomically. Clamps to zero (defensive).
 * When the count reaches zero, sets orphanedAt = now so the orphan cleanup
 * worker can sweep it after the configured grace period. Returns the new refCount.
 */
export const decRef = async (
  hash: string,
  tx: Prisma.TransactionClient
): Promise<number> => {
  const rows = await tx.$queryRaw<{ ref_count: number }[]>`
    UPDATE "files"."content_blobs"
    SET "ref_count" = GREATEST(0, "ref_count" - 1),
        "orphaned_at" = CASE
          WHEN GREATEST(0, "ref_count" - 1) = 0 THEN NOW()
          ELSE "orphaned_at"
        END
    WHERE "hash" = ${hash}
    RETURNING "ref_count"
  `;
  if (rows.length === 0) {
    throw new NotFoundError("Content blob not found");
  }
  return rows[0].ref_count;
};

/**
 * Claim a single orphaned blob for deletion. Returns the blob row if it is
 * still orphaned and past the grace period, otherwise null.
 *
 * Uses FOR UPDATE SKIP LOCKED so concurrent workers don't fight for the same
 * row. Caller must either delete the row + file or release the lock.
 */
export const claimOrphan = async (
  hash: string,
  graceSeconds: number,
  tx: Prisma.TransactionClient
) => {
  const rows = await tx.$queryRaw<
    {
      hash: string;
      fs_path: string;
      ref_count: number;
      orphaned_at: Date | null;
    }[]
  >`
    SELECT "hash", "fs_path", "ref_count", "orphaned_at"
    FROM "files"."content_blobs"
    WHERE "hash" = ${hash}
      AND "ref_count" = 0
      AND "orphaned_at" IS NOT NULL
      AND "orphaned_at" <= NOW() - (${graceSeconds}::int || ' seconds')::interval
    FOR UPDATE SKIP LOCKED
  `;
  if (rows.length === 0) return null;
  return rows[0];
};

/**
 * Row-lock a single ContentBlob for the duration of the caller's transaction
 * (SELECT ... FOR UPDATE). Returns a minimal snapshot of the locked row, or
 * null if the row no longer exists (e.g. orphan-cleanup already deleted it).
 * Used by the restore flow to freeze the blob's refCount / orphanedAt while
 * it decides whether the underlying file is still safe to reuse.
 */
export const lockByHashForUpdate = async (
  hash: string,
  tx: Prisma.TransactionClient
): Promise<{
  hash: string;
  refCount: number;
  orphanedAt: Date | null;
} | null> => {
  const rows = await tx.$queryRaw<
    { hash: string; ref_count: number; orphaned_at: Date | null }[]
  >`
    SELECT "hash", "ref_count", "orphaned_at"
    FROM "files"."content_blobs"
    WHERE "hash" = ${hash}
    FOR UPDATE
  `;
  if (rows.length === 0) return null;
  return {
    hash: rows[0].hash,
    refCount: rows[0].ref_count,
    orphanedAt: rows[0].orphaned_at,
  };
};

/**
 * List hashes of blobs that are currently marked orphaned (refCount=0,
 * orphanedAt set) and have been so for longer than `graceSeconds`. Oldest
 * first, resuming after `after` (the last row of the previous page). Used by
 * the hourly orphan-backstop to find blobs that should have been cleaned up
 * but weren't (missed enqueue, Redis hiccup, crash).
 */
export const listOrphansPastGrace = async (
  graceSeconds: number,
  limit: number,
  after?: { hash: string; orphanedAt: Date },
  tx?: Prisma.TransactionClient
): Promise<{ hash: string; orphanedAt: Date }[]> => {
  const client = tx ?? prisma;
  const afterClause = after
    ? Prisma.sql`AND ("orphaned_at", "hash") > (${after.orphanedAt}, ${after.hash})`
    : Prisma.empty;
  return await client.$queryRaw<{ hash: string; orphanedAt: Date }[]>`
    SELECT "hash", "orphaned_at" AS "orphanedAt"
    FROM "files"."content_blobs"
    WHERE "ref_count" = 0
      AND "orphaned_at" IS NOT NULL
      AND "orphaned_at" <= NOW() - (${graceSeconds}::int || ' seconds')::interval
      ${afterClause}
    ORDER BY "orphaned_at" ASC, "hash" ASC
    LIMIT ${limit}
  `;
};

/**
 * Row-lock blobs in hash order (byte order, which JS string comparison
 * matches), skipping any that no longer exist. A transaction that changes
 * more than one blob's refCount takes them all through here first, after the
 * bucket row, so two such transactions never hold rows the other waits for.
 * `attach` takes a blob's advisory lock and then its row: a caller attaching
 * one blob among others locks those below its hash before the attach, and
 * those above after.
 */
export const lockInOrder = async (
  hashes: Iterable<string>,
  tx: Prisma.TransactionClient
): Promise<void> => {
  const unique = [...new Set(hashes)];
  if (unique.length === 0) return;
  await tx.$queryRaw`
    SELECT "hash"
    FROM "files"."content_blobs"
    WHERE "hash" = ANY(${unique}::text[])
    ORDER BY "hash" COLLATE "C"
    FOR NO KEY UPDATE
  `;
};

/**
 * Release one ref per occurrence of a hash in `hashes`, locking the rows in
 * hash order first. Returns each released blob with its new refCount and
 * the bytes released (its size times its occurrences).
 */
export const decRefMany = async (
  hashes: string[],
  tx: Prisma.TransactionClient
): Promise<{ hash: string; refCount: number; releasedBytes: bigint }[]> => {
  if (hashes.length === 0) return [];
  const counts = new Map<string, number>();
  for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  await lockInOrder(counts.keys(), tx);
  const rows = await tx.$queryRaw<
    { hash: string; ref_count: number; released_bytes: bigint }[]
  >`
    UPDATE "files"."content_blobs" cb
    SET "ref_count" = GREATEST(0, cb."ref_count" - counts.cnt),
        "orphaned_at" = CASE
          WHEN GREATEST(0, cb."ref_count" - counts.cnt) = 0 THEN NOW()
          ELSE cb."orphaned_at"
        END
    FROM unnest(${[...counts.keys()]}::text[], ${[...counts.values()]}::int[])
      AS counts(hash, cnt)
    WHERE cb."hash" = counts.hash
    RETURNING cb."hash", cb."ref_count",
      (cb."size_bytes" * counts.cnt)::bigint AS released_bytes
  `;
  return rows.map((r) => ({
    hash: r.hash,
    refCount: r.ref_count,
    releasedBytes: r.released_bytes,
  }));
};

/**
 * Release the blob ref of every live (non-delete-marker, non-soft-deleted)
 * version of the given Objects. Each version is marked deleted under its row
 * lock first and only the versions that transition are counted, so a version
 * another transaction is releasing concurrently (the history purge, version
 * expiry, bucket cleanup) is released exactly once.
 *
 * Returns the hashes whose refCount reached 0, and the summed size of the
 * released versions for the caller's usage refund.
 */
export const decRefForObjectVersions = async (
  objectIds: string[],
  tx: Prisma.TransactionClient
): Promise<{ freedHashes: string[]; releasedBytes: bigint }> => {
  if (objectIds.length === 0) return { freedHashes: [], releasedBytes: 0n };
  const released = await tx.$queryRaw<{ hash: string }[]>`
    UPDATE "files"."object_versions"
    SET "deleted_at" = NOW()
    WHERE "object_id" = ANY(${objectIds}::uuid[])
      AND "deleted_at" IS NULL
      AND "is_delete_marker" = false
      AND "content_blob_hash" IS NOT NULL
    RETURNING "content_blob_hash" AS hash
  `;
  const rows = await decRefMany(
    released.map((r) => r.hash),
    tx
  );
  return {
    freedHashes: rows.filter((r) => r.refCount === 0).map((r) => r.hash),
    releasedBytes: rows.reduce((sum, r) => sum + r.releasedBytes, 0n),
  };
};

export const deleteByHash = async (
  hash: string,
  tx: Prisma.TransactionClient
): Promise<void> => {
  await tx.contentBlob.delete({ where: { hash } });
};
