import { createReadStream, createWriteStream } from "fs";
import type { Readable, Writable } from "stream";
import { logger } from "./logger.js";
import fs from "fs/promises";
import crypto from "crypto";
import env from "../env.js";
import path from "path";

/**
 * One request's local temp files, in `FILE_SERVICE_TEMP_PATH`: multer's spool
 * of an upload (plaintext) and the encrypted file staged before its hash is
 * known. They stay on local disk whatever backend holds the blobs.
 */
export type ScratchKind = "upload" | "signed-upload" | "mp-complete";

// Only names core writes are swept: the directory may be shared (`/tmp`).
const SCRATCH_NAME = /^(upload|signed-upload|mp-complete)-[0-9a-f]+$/;

export function scratchDir(): string {
  return env.FILE_SERVICE_TEMP_PATH;
}

export function scratchName(kind: ScratchKind): string {
  return `${kind}-${crypto.randomBytes(12).toString("hex")}`;
}

export async function ensureScratchDir(): Promise<void> {
  await fs.mkdir(scratchDir(), { recursive: true });
}

export async function createScratchFile(
  kind: ScratchKind
): Promise<{ path: string; stream: Writable }> {
  await ensureScratchDir();
  const filePath = path.join(scratchDir(), scratchName(kind));
  return { path: filePath, stream: createWriteStream(filePath) };
}

export function openScratchRead(filePath: string): Readable {
  return createReadStream(filePath);
}

/** The first `bytes` of the file, fewer when it is shorter. */
export async function readScratchHead(
  filePath: string,
  bytes: number
): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Remove a scratch file. Ignores ENOENT. */
export async function discardScratchFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Delete the scratch files a crash left behind: top-level files core named,
 * by mtime, older than `maxAgeMs`. Returns how many were removed. `shouldStop`
 * is asked before each file, so a shutdown need not wait out the directory.
 */
export async function sweepStaleScratchFiles(
  maxAgeMs: number,
  now = Date.now(),
  shouldStop: () => boolean = () => false
): Promise<number> {
  const root = scratchDir();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  let removed = 0;
  for (const entry of entries) {
    if (shouldStop()) break;
    if (!entry.isFile() || !SCRATCH_NAME.test(entry.name)) continue;
    const p = path.join(root, entry.name);
    try {
      const { mtimeMs } = await fs.stat(p);
      if (now - mtimeMs < maxAgeMs) continue;
      await fs.unlink(p);
      removed++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      logger.warn({ err, path: p }, "Failed to remove stale temp file");
    }
  }
  return removed;
}
