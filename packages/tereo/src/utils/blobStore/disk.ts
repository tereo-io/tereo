import type { BlobListCursor, BlobListing, BlobStore } from "./types.js";
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import type { Readable } from "stream";
import fs from "fs/promises";
import crypto from "crypto";
import path from "path";

const SHARD_NAME = /^[0-9a-f]{2}$/;

const isEnoent = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException | null)?.code === "ENOENT";

async function syncFile(filePath: string): Promise<void> {
  const fh = await fs.open(filePath, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Remove a file; false when it was already gone. */
async function unlinkIfPresent(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

/** The names in a directory that pass `keep`, sorted; none when it is absent. */
async function listNames(
  dir: string,
  keep: (entry: {
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
  }) => boolean
): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  return entries
    .filter(keep)
    .map((e) => e.name)
    .sort();
}

/**
 * Blobs and multipart parts as files under `root()`, read at each call: a blob at
 * `blobs/{hash[0:2]}/{hash[2:4]}/{hash}`, a part at
 * `multipart/{uploadId}/{partNumber}.{nonce}`. A location is the file's path.
 */
export function createDiskBlobStore(root: () => string): BlobStore {
  const blobsRoot = () => path.join(root(), "blobs");
  const uploadDir = (uploadId: string) =>
    path.join(root(), "multipart", uploadId);

  return {
    async ensureReady() {
      await fs.mkdir(blobsRoot(), { recursive: true });
    },

    locationFor(hash) {
      if (hash.length < 4) {
        throw new Error("Hash too short for sharding");
      }
      return path.join(blobsRoot(), hash.slice(0, 2), hash.slice(2, 4), hash);
    },

    // Only the writer that created the blob's row calls this, holding the
    // blob's lock (`contentBlobs.attach`): a file already at the path then
    // belongs to no row — a write that rolled back, or an orphan whose row
    // was just deleted — so nothing reads it under the row's key material.
    //
    // The staged file is fsynced first, so a crash can't leave a short file
    // at the content address for later reads to serve. A staged file on
    // another filesystem (`FILE_SERVICE_TEMP_PATH` on its own volume) cannot
    // be renamed across: it is copied beside the target, fsynced and renamed
    // from there, so the content address still never holds a partial file.
    async place(scratchPath, location) {
      await syncFile(scratchPath);
      await fs.mkdir(path.dirname(location), { recursive: true });
      try {
        await fs.rename(scratchPath, location);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        const copyPath = `${location}.${crypto.randomBytes(8).toString("hex")}.tmp`;
        try {
          await fs.copyFile(scratchPath, copyPath);
          await syncFile(copyPath);
          await fs.rename(copyPath, location);
        } catch (copyErr) {
          await fs.unlink(copyPath).catch(() => {});
          throw copyErr;
        }
        await fs.unlink(scratchPath).catch(() => {});
      }
    },

    openRead(location, range) {
      return createReadStream(location, range);
    },

    async readHead(location, bytes) {
      const fh = await fs.open(location, "r");
      try {
        const head = Buffer.alloc(bytes);
        const { bytesRead } = await fh.read(head, 0, bytes, 0);
        return head.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },

    async exists(location) {
      try {
        await fs.access(location);
        return true;
      } catch {
        return false;
      }
    },

    delete: unlinkIfPresent,

    listShards() {
      // Only sharded names: stragglers like lost+found are not shards.
      return listNames(
        blobsRoot(),
        (e) => e.isDirectory() && SHARD_NAME.test(e.name)
      );
    },

    async *listBlobs(
      shard: string,
      cursor: BlobListCursor = {}
    ): AsyncIterable<BlobListing> {
      const shardPath = path.join(blobsRoot(), shard);
      const subs = await listNames(
        shardPath,
        (e) => e.isDirectory() && SHARD_NAME.test(e.name)
      );
      for (const sub of subs) {
        if (cursor.sub && sub < cursor.sub) continue;
        const after = sub === cursor.sub ? cursor.afterFile : undefined;
        const subPath = path.join(shardPath, sub);
        const names = await listNames(subPath, (e) => e.isFile());
        for (const hash of names) {
          if (after && hash <= after) continue;
          yield {
            hash,
            location: path.join(subPath, hash),
            cursor: { sub, afterFile: hash },
          };
        }
      }
    },

    // Each write picks a fresh nonce so concurrent retries of one
    // `partNumber` never write to the same file — the DB upsert serialises
    // which one becomes "live" via the `(uploadId, partNumber)` unique index,
    // and the loser's bytes are deleted by the controller. A path fixed by
    // (uploadId, partNumber) would let two streams truncate and intermix one
    // file while the DB row's etag and size described only one of them.
    async writePart(uploadId, partNumber, source) {
      const dir = uploadDir(uploadId);
      await fs.mkdir(dir, { recursive: true });
      const nonce = crypto.randomBytes(8).toString("hex");
      const location = path.join(dir, `${partNumber}.${nonce}`);
      try {
        await pipeline(source, createWriteStream(location));
      } catch (err) {
        await fs.unlink(location).catch(() => {});
        throw err;
      }
      return location;
    },

    openPart(location: string): Readable {
      return createReadStream(location);
    },

    async deletePart(location) {
      await unlinkIfPresent(location);
    },

    async releaseUploadIfEmpty(uploadId) {
      // rmdir refuses a directory that still holds a part.
      await fs.rmdir(uploadDir(uploadId)).catch(() => {});
    },

    async removeUpload(uploadId) {
      await fs.rm(uploadDir(uploadId), { recursive: true, force: true });
    },

    isMissing: isEnoent,
  };
}
