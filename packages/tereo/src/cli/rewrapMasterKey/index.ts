import { prisma } from "../../utils/db/prisma.js";
import { logger } from "../../utils/logger.js";
import { loadKeys } from "../../utils/keys.js";
import env from "../../env.js";
import z from "zod";
import {
  aadForBlobHash,
  aadForUploadId,
  unwrapDek,
  wrapDek,
} from "../../utils/encryption.js";

/**
 * Re-wrap every wrapped DEK in the database under
 * `FILE_SERVICE_ACTIVE_MASTER_KEY_VERSION`, so an older master key can be
 * retired: roll every process onto the new active version, run this, then run
 * it again with `--dry-run` until it reports nothing to rewrap and nothing
 * failed. Only then is no live row under the old key. It changes no DEK and no
 * ciphertext, so it does not undo an exposure of the old master key together
 * with the database: those DEKs were exposed with it.
 *
 * Two scopes are walked:
 *   - `content_blobs` — long-lived blobs (the load-bearing case).
 *   - `multipart_uploads` — in-flight upload staging DEKs. Active uploads will
 *     keep working since the AAD (`uploadId`) doesn't change; only the master
 *     key version flips.
 *
 * Properties:
 *   - **Idempotent.** A row already at the active version is skipped.
 *   - **Resumable.** Walks by primary key ASC and logs its cursor after
 *     every page; pass `--from-hash <hex>` / `--from-upload <uuid>` to start
 *     after the last one logged.
 *   - **Keeps going past a bad row.** A DEK that cannot be unwrapped (an
 *     unknown key version, a corrupt row) is logged and counted as `failed`,
 *     and the CLI exits non-zero; the rest are still rewrapped.
 *   - **Safe under concurrency.** Each row is rewritten by one
 *     compare-and-set `UPDATE … WHERE wrapped_dek = <read> AND
 *     master_key_version = <old>`, so it changes the wrapped DEK and its
 *     version together or not at all. If the row changed since it was read (a
 *     concurrent rewrap, or a delete and re-create, which wraps a new DEK),
 *     the update matches nothing and the row counts as skipped, not rewrapped.
 *   - **No file IO.** Only the wrapped DEK in the DB row changes. The on-disk
 *     ciphertext is unaffected — the unwrapped DEK + IV stay identical, just
 *     wrapped under a different master key.
 */
export interface RewrapOptions {
  /** Hash to start from (exclusive of earlier hashes). For resuming. */
  fromHash?: string;
  /** Upload id to start from (exclusive of earlier ids). For resuming. */
  fromUpload?: string;
  /** Stop after walking this many of each table. Defaults to no cap. */
  limit?: number;
  /** Page size for the cursor walk. Default 200. */
  pageSize?: number;
  /** Don't write — just count what would change. */
  dryRun?: boolean;
}

interface RewrapCounts {
  scanned: number;
  rewrapped: number;
  skipped: number;
  failed: number;
}

export interface RewrapResult {
  blobs: RewrapCounts;
  multipartUploads: RewrapCounts;
}

/** The DEK re-wrapped under `toVersion`, or null (logged) if it can't be unwrapped. */
function rewrap(
  wrapped: Buffer,
  fromVersion: number,
  toVersion: number,
  aad: Buffer,
  row: Record<string, string>
): Buffer | null {
  let dek: Buffer;
  try {
    dek = unwrapDek(wrapped, fromVersion, aad);
  } catch (err) {
    logger.error(
      { err, ...row, masterKeyVersion: fromVersion },
      "rewrap-master-key could not unwrap a DEK; left as it is"
    );
    return null;
  }
  const newWrapped = wrapDek(dek, toVersion, aad);
  // Wipe the unwrapped DEK from our view as soon as we've re-wrapped.
  dek.fill(0);
  return newWrapped;
}

export async function rewrapMasterKey(
  opts: RewrapOptions = {}
): Promise<RewrapResult> {
  await loadKeys();
  const targetVersion = env.FILE_SERVICE_ACTIVE_MASTER_KEY_VERSION;
  const pageSize = opts.pageSize ?? 200;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const dryRun = !!opts.dryRun;

  logger.info(
    {
      targetVersion,
      pageSize,
      limit: Number.isFinite(limit) ? limit : null,
      dryRun,
    },
    "rewrap-master-key starting"
  );

  const result: RewrapResult = {
    blobs: { scanned: 0, rewrapped: 0, skipped: 0, failed: 0 },
    multipartUploads: { scanned: 0, rewrapped: 0, skipped: 0, failed: 0 },
  };

  // ---- Content blobs --------------------------------------------------------
  let blobCursor: string | undefined = opts.fromHash;
  while (result.blobs.scanned < limit) {
    const page = await prisma.contentBlob.findMany({
      where: blobCursor ? { hash: { gt: blobCursor } } : undefined,
      orderBy: { hash: "asc" },
      take: Math.min(pageSize, limit - result.blobs.scanned),
      select: {
        hash: true,
        masterKeyVersion: true,
        wrappedDek: true,
      },
    });
    if (page.length === 0) break;

    for (const row of page) {
      result.blobs.scanned++;
      blobCursor = row.hash;

      if (row.masterKeyVersion === targetVersion) {
        result.blobs.skipped++;
        continue;
      }

      const aad = aadForBlobHash(row.hash);
      const newWrapped = rewrap(
        Buffer.from(row.wrappedDek),
        row.masterKeyVersion,
        targetVersion,
        aad,
        { hash: row.hash }
      );
      if (!newWrapped) {
        result.blobs.failed++;
        continue;
      }

      if (dryRun) {
        result.blobs.rewrapped++;
        continue;
      }

      // Matches nothing if the row was rewrapped or deleted since it was read.
      const updated = await prisma.$executeRaw`
        UPDATE "files"."content_blobs"
        SET "wrapped_dek" = ${newWrapped}::bytea,
            "master_key_version" = ${targetVersion}
        WHERE "hash" = ${row.hash}
          AND "master_key_version" = ${row.masterKeyVersion}
          AND "wrapped_dek" = ${Buffer.from(row.wrappedDek)}::bytea
      `;
      if (updated === 1) result.blobs.rewrapped++;
      else result.blobs.skipped++;
    }

    logger.info(
      { table: "content_blobs", after: blobCursor, ...result.blobs },
      "rewrap-master-key progress"
    );
    if (page.length < pageSize) break;
  }

  // ---- Multipart staging DEKs ----------------------------------------------
  let uploadCursor: string | undefined = opts.fromUpload;
  while (result.multipartUploads.scanned < limit) {
    const page = await prisma.multipartUpload.findMany({
      where: {
        completedAt: null,
        abortedAt: null,
        ...(uploadCursor ? { id: { gt: uploadCursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: Math.min(pageSize, limit - result.multipartUploads.scanned),
      select: {
        id: true,
        wrappedStagingDek: true,
        stagingDekMasterKeyVersion: true,
      },
    });
    if (page.length === 0) break;

    for (const row of page) {
      result.multipartUploads.scanned++;
      uploadCursor = row.id;

      if (row.stagingDekMasterKeyVersion === targetVersion) {
        result.multipartUploads.skipped++;
        continue;
      }

      const aad = aadForUploadId(row.id);
      const newWrapped = rewrap(
        Buffer.from(row.wrappedStagingDek),
        row.stagingDekMasterKeyVersion,
        targetVersion,
        aad,
        { uploadId: row.id }
      );
      if (!newWrapped) {
        result.multipartUploads.failed++;
        continue;
      }

      if (dryRun) {
        result.multipartUploads.rewrapped++;
        continue;
      }

      const updated = await prisma.$executeRaw`
        UPDATE "files"."multipart_uploads"
        SET "wrapped_staging_dek" = ${newWrapped}::bytea,
            "staging_dek_master_key_version" = ${targetVersion}
        WHERE "id" = ${row.id}
          AND "staging_dek_master_key_version" = ${row.stagingDekMasterKeyVersion}
          AND "wrapped_staging_dek" = ${Buffer.from(row.wrappedStagingDek)}::bytea
      `;
      if (updated === 1) result.multipartUploads.rewrapped++;
      else result.multipartUploads.skipped++;
    }

    logger.info(
      {
        table: "multipart_uploads",
        after: uploadCursor,
        ...result.multipartUploads,
      },
      "rewrap-master-key progress"
    );
    if (page.length < pageSize) break;
  }

  logger.info(result, "rewrap-master-key complete");
  return result;
}

export class RewrapUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RewrapUsageError";
  }
}

const USAGE = [
  "Usage: npm run cli -- rewrap-master-key [options]",
  "",
  "Re-wraps every wrapped DEK under FILE_SERVICE_ACTIVE_MASTER_KEY_VERSION.",
  "Idempotent and resumable.",
  "",
  "Options:",
  "  --dry-run                Count what would change without writing.",
  "  --from-hash <hex>        Resume content_blobs walk after this hash.",
  "  --from-upload <uuid>     Resume multipart_uploads walk after this id.",
  "  --limit <n>              Cap rows scanned per table.",
  "  --page-size <n>          Cursor page size (default 200).",
].join("\n");

const uuid = z.string().uuid();
const hex = z.string().regex(/^[0-9a-f]+$/i);
const positiveInt = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().safe());

/**
 * Parses argv; throws `RewrapUsageError` on anything malformed. A typo must
 * not run a live rewrap or end in the all-zero report that clears an old
 * master key for deletion.
 */
export function parseRewrapArgs(argv: string[]): RewrapOptions {
  const opts: RewrapOptions = {};
  const value = (flag: string, i: number): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) {
      throw new RewrapUsageError(`${flag} needs a value`);
    }
    return v;
  };
  const count = (flag: string, i: number): number => {
    const raw = value(flag, i);
    const parsed = positiveInt.safeParse(raw);
    if (!parsed.success) {
      throw new RewrapUsageError(`${flag} is not a positive integer: ${raw}`);
    }
    return parsed.data;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--from-hash") {
      const hash = value(arg, ++i);
      if (!hex.safeParse(hash).success) {
        throw new RewrapUsageError(`--from-hash is not a hex hash: ${hash}`);
      }
      opts.fromHash = hash;
    } else if (arg === "--from-upload") {
      const id = value(arg, ++i);
      if (!uuid.safeParse(id).success) {
        throw new RewrapUsageError(`--from-upload is not a uuid: ${id}`);
      }
      opts.fromUpload = id;
    } else if (arg === "--limit") {
      opts.limit = count(arg, ++i);
    } else if (arg === "--page-size") {
      opts.pageSize = count(arg, ++i);
    } else {
      throw new RewrapUsageError(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

export async function runRewrapCli(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.error(USAGE);
    return;
  }
  let opts: RewrapOptions;
  try {
    opts = parseRewrapArgs(argv);
  } catch (err) {
    if (!(err instanceof RewrapUsageError)) throw err;
    console.error(err.message);
    console.error("");
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const result = await rewrapMasterKey(opts);
  console.log(JSON.stringify(result, null, 2));
  if (result.blobs.failed + result.multipartUploads.failed > 0) {
    process.exitCode = 1;
  }
}
