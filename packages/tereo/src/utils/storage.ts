import { Readable, Transform, pipeline as pipelineCb } from "stream";
import { createReadStream, createWriteStream } from "fs";
import { promisify } from "util";
import fs from "fs/promises";
import crypto from "crypto";
import env from "../env.js";
import path from "path";
import {
  BLOB_HEADER_BYTES,
  EncryptedBlobKeyMaterial,
  checkBlobHeader,
  createRangeDecipher,
  createDecryptStream,
  createEncryptStream,
  createMultipartPartDecryptStream,
  createMultipartPartEncryptStream,
  aadForPart,
} from "./encryption.js";

const pipeline = promisify(pipelineCb);

/**
 * Refuse to stream an upload whose body a parser already read: the stream
 * would end at once and store an empty object. body-parser marks a request
 * it consumed with `_body`.
 */
export function assertUnreadBody(source: Readable): void {
  if (source.readableEnded || (source as { _body?: boolean })._body) {
    throw new Error("Upload body was consumed before it could be streamed");
  }
}

/**
 * An encrypted blob written to a temp file, not yet at its content-addressed
 * path. `contentBlobs.attach` moves it to `fsPath` only when its write
 * creates the `ContentBlob` row; otherwise the existing row and file are
 * shared and the staged file is dropped.
 */
export interface SaveBlobResult {
  hash: string;
  etag: string;
  fsPath: string;
  sizeBytes: number;
  stagedPath: string;
  keyMaterial: EncryptedBlobKeyMaterial;
}

export interface BlobMeta {
  fsPath: string;
  keyMaterial: EncryptedBlobKeyMaterial;
}

/**
 * Ensure the global blob root directory exists.
 */
export async function ensureBlobDirectory(): Promise<void> {
  await fs.mkdir(blobRootPath(), { recursive: true });
}

/**
 * Ensure temp directory exists
 */
export async function ensureTempDirectory(): Promise<void> {
  await fs.mkdir(env.FILE_SERVICE_TEMP_PATH, { recursive: true });
}

function blobRootPath(): string {
  return path.join(env.FILE_SERVICE_STORAGE_PATH, "blobs");
}

export function getBlobPath(hash: string): string {
  const { level1, level2, filename } = getShardedPath(hash);
  return path.join(blobRootPath(), level1, level2, filename);
}

function getMultipartDirPath(uploadId: string): string {
  return path.join(env.FILE_SERVICE_STORAGE_PATH, "multipart", uploadId);
}

/**
 * Build a unique on-disk path for a freshly-staged part. Each PUT picks a
 * fresh nonce so concurrent retries to the same `partNumber` never write to
 * the same file — the DB upsert serialises which one becomes "live" via the
 * `(uploadId, partNumber)` unique index, and the loser's bytes get unlinked
 * by the controller. A deterministic-by-(uploadId,partNumber) path used to be
 * a hidden race: two streams would `createWriteStream` the same file with
 * the default truncate flag, intermix bytes, and the DB row's etag/sizeBytes
 * could end up describing one writer's bytes while the disk held the other's.
 */
function getMultipartPartPath(
  uploadId: string,
  partNumber: number,
  nonce: string
): string {
  return path.join(getMultipartDirPath(uploadId), `${partNumber}.${nonce}`);
}

async function ensureMultipartDir(uploadId: string): Promise<void> {
  await fs.mkdir(
    path.join(env.FILE_SERVICE_STORAGE_PATH, "multipart", uploadId),
    { recursive: true }
  );
}

export async function removeMultipartDir(uploadId: string): Promise<void> {
  const dir = path.join(env.FILE_SERVICE_STORAGE_PATH, "multipart", uploadId);
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Move a staged encrypted file to its content-addressed path, replacing
 * whatever is there. Only the writer that created the blob's row calls this,
 * holding the blob's lock (`contentBlobs.attach`): a file already at the path
 * then belongs to no row — a write that rolled back, or an orphan whose row
 * was just deleted — so nothing reads it under the row's key material.
 *
 * The staged file is fsynced first, so a crash can't leave a short file at
 * the content address for later reads to serve.
 */
export async function placeBlobFile(
  stagedPath: string,
  targetPath: string
): Promise<void> {
  const fh = await fs.open(stagedPath, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.rename(stagedPath, targetPath);
}

/** Remove a staged file that was not placed. Ignores ENOENT. */
export async function discardStagedFile(stagedPath: string): Promise<void> {
  await deleteBlobFile(stagedPath);
}

/**
 * Stage a multipart part to disk **encrypted** under the upload's staging DEK.
 *
 * On-disk layout per part: `iv(12) || ciphertext || tag(16)` — the IV is
 * fresh per part so reusing the same DEK across parts of one upload is safe.
 * The hash, etag, and size returned here are all over the *plaintext* (so the
 * S3-compatible per-part MD5 etag and the dedup-hint SHA-256 stay
 * content-addressed). `sizeBytes` is plaintext length; the on-disk file is
 * `sizeBytes + 28` bytes long.
 *
 * Computes BOTH a SHA-256 (used internally for part identity/dedup hints) and
 * an MD5 that is returned as the S3-style part `etag`. The combined object
 * ETag is derived from the binary MD5 of each part (see completeMultipart) so
 * per-part MD5 is the load-bearing value here.
 */
export async function stagePart(
  uploadId: string,
  partNumber: number,
  source: Readable,
  maxBytes: number,
  stagingDek: Buffer
): Promise<{
  fsPath: string;
  sizeBytes: number;
  etag: string;
  sha256: string;
}> {
  assertUnreadBody(source);
  await ensureMultipartDir(uploadId);
  // Each stage uses a fresh nonce so concurrent retries cannot collide on the
  // same on-disk file. The DB upsert decides which one wins; the prior
  // fsPath (if any) is unlinked by the controller after the upsert.
  const nonce = crypto.randomBytes(8).toString("hex");
  const fsPath = getMultipartPartPath(uploadId, partNumber, nonce);

  const sha256Hasher = crypto.createHash("sha256");
  const md5Hasher = crypto.createHash("md5");
  let sizeBytes = 0;
  // Counter + size-cap enforcement + hasher in a single Transform so the
  // request stream has exactly one consumer (this pipeline). Earlier versions
  // split size-limit enforcement into a middleware that attached a `data`
  // listener, which put the request stream into flowing mode before this
  // pipeline was ready — any body bytes that arrived while the controller
  // waited on async DB lookups drained into the counter and never reached the
  // write stream, causing staged parts to end up short. Keeping everything in
  // one pipeline eliminates that window.
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) {
        cb(
          Object.assign(
            new Error(
              `Part upload exceeds ${Math.round(
                maxBytes / (1024 * 1024)
              )}MB limit`
            ),
            { code: "LIMIT_FILE_SIZE", statusCode: 413 }
          )
        );
        return;
      }
      sha256Hasher.update(chunk);
      md5Hasher.update(chunk);
      cb(null, chunk);
    },
  });

  const partCipher = createMultipartPartEncryptStream(
    stagingDek,
    aadForPart(uploadId, partNumber)
  );
  try {
    await pipeline(source, meter, partCipher, createWriteStream(fsPath));
  } catch (err) {
    await fs.unlink(fsPath).catch(() => {});
    throw err;
  }
  return {
    fsPath,
    sizeBytes,
    etag: md5Hasher.digest("hex"),
    sha256: sha256Hasher.digest("hex"),
  };
}

/**
 * Open a read stream that yields plaintext bytes from a staged multipart
 * part. The part is decrypted under the upload's staging DEK as it streams;
 * `aad` is null for a part staged unbound (`aad_bound = false`).
 */
export function openMultipartPartStream(
  fsPath: string,
  stagingDek: Buffer,
  aad: Buffer | null
): Readable {
  const decrypt = createMultipartPartDecryptStream(stagingDek, aad);
  // pipeline, not pipe: a read error (a missing file) reaches the reader.
  pipelineCb(createReadStream(fsPath), decrypt, () => {});
  return decrypt;
}

/**
 * Save a plaintext stream as an encrypted content-addressed blob.
 *
 * The SHA-256 is computed over the PLAINTEXT so dedup is content-based.
 * The on-disk file (v1 format) is `BLOB_MAGIC_V1 || ciphertext || tag(16)`.
 *
 * The DEK is wrapped *after* the hash is known, with AAD = blob hash bytes.
 * That binds the wrapped DEK to its content so an attacker with DB write
 * access can't swap key material between rows.
 *
 * The ciphertext stays at `stagedPath` until `contentBlobs.attach` decides
 * whether this write creates the blob (and places the file) or shares an
 * existing one. Callers discard `stagedPath` when they are done either way.
 */
export async function saveBlobStream(
  source: Readable
): Promise<SaveBlobResult> {
  // Hash the plaintext by tee-ing the stream through a SHA-256 while we also
  // feed an encrypted copy into a tmp file. We can't know the final hash until
  // the stream ends, so we write to a temp name first and rename once we know.
  const tempPath = path.join(
    env.FILE_SERVICE_TEMP_PATH,
    `upload-${crypto.randomBytes(12).toString("hex")}`
  );
  await ensureTempDirectory();

  const plaintextHasher = crypto.createHash("sha256");
  const md5Hasher = crypto.createHash("md5");
  let plaintextSize = 0;

  const plaintextMeter = new Transform({
    transform(chunk, _enc, cb) {
      plaintextSize += chunk.length;
      plaintextHasher.update(chunk);
      md5Hasher.update(chunk);
      cb(null, chunk);
    },
  });

  const { stream: encryptStream, finalize } = createEncryptStream();

  try {
    await pipeline(
      source,
      plaintextMeter,
      encryptStream,
      createWriteStream(tempPath)
    );
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }

  const hash = plaintextHasher.digest("hex");
  return {
    hash,
    etag: md5Hasher.digest("hex"),
    fsPath: getBlobPath(hash),
    sizeBytes: plaintextSize,
    stagedPath: tempPath,
    keyMaterial: finalize(hash),
  };
}

/**
 * Save a Buffer as an encrypted content-addressed blob. Thin convenience wrapper
 * around saveBlobStream for small payloads (thumbnails, etc.).
 */
export async function saveBlobBuffer(buf: Buffer): Promise<SaveBlobResult> {
  return await saveBlobStream(Readable.from(buf));
}

/**
 * Open a read stream that yields plaintext for an encrypted blob. The hash is
 * required because v1 blobs bind the wrapped DEK to it via AAD.
 */
export function openBlobStream(meta: BlobMeta, blobHash: string) {
  const fileStream = createReadStream(meta.fsPath);
  const decrypt = createDecryptStream(meta.keyMaterial, blobHash);
  // Not `.pipe`: destroying the returned stream must close the file too, and
  // a read error must surface on it. Errors reach callers through `decrypt`.
  return pipelineCb(fileStream, decrypt, () => {});
}

/**
 * Plaintext bytes `start`..`end` (inclusive) of an encrypted blob, read from
 * the middle of the file rather than decrypting everything before `start`
 * (see `createRangeDecipher`). Not authenticated by the GCM tag.
 */
export async function openBlobRangeStream(
  meta: BlobMeta,
  blobHash: string,
  start: number,
  end: number
): Promise<Readable> {
  const fh = await fs.open(meta.fsPath, "r");
  try {
    const header = Buffer.alloc(BLOB_HEADER_BYTES);
    const { bytesRead } = await fh.read(header, 0, BLOB_HEADER_BYTES, 0);
    checkBlobHeader(header.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
  const { decipher, fileOffset, skip } = createRangeDecipher(
    meta.keyMaterial,
    blobHash,
    start
  );
  const file = createReadStream(meta.fsPath, {
    start: fileOffset,
    end: BLOB_HEADER_BYTES + end,
  });
  let toSkip = skip;
  const trim = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (toSkip >= chunk.length) {
        toSkip -= chunk.length;
        return cb();
      }
      const out = chunk.subarray(toSkip);
      toSkip = 0;
      cb(null, out);
    },
  });
  // As in `openBlobStream`: destroying `trim` closes the file, and errors
  // surface on it.
  return pipelineCb(file, decipher, trim, () => {});
}

/**
 * Read an encrypted blob fully into a Buffer (used when the caller needs the
 * plaintext in memory — e.g. thumbnail generation).
 */
async function readBlob(meta: BlobMeta, blobHash: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = openBlobStream(meta, blobHash);
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// Blobs at or below this size are fully decrypted, GCM-verified, AND
// re-hashed against their content address in memory before any response byte
// is sent. Above it, downloads stream — GCM still verifies, but only after the
// plaintext is already on the wire, so a storage-level tamperer (filesystem
// write, no keys) could have forged bytes delivered as a complete-looking
// response. The streaming-AEAD framing migration is the full fix for large
// blobs; this threshold closes the realistic attack window (labels, CSVs,
// price lists, JSON — all small, predictable-plaintext targets) cheaply.
const INTEGRITY_VERIFY_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB

/**
 * For blobs small enough to buffer (<= INTEGRITY_VERIFY_MAX_BYTES), return the
 * fully decrypted plaintext only after verifying it end-to-end: `readBlob`
 * runs GCM authentication, and we additionally re-hash the plaintext and
 * compare it to the content address. Returns null for larger blobs (caller
 * should stream). THROWS on any integrity failure — callers MUST await this
 * BEFORE writing response headers/body so a tampered blob produces a clean
 * error instead of a forged, complete-looking download.
 */
export async function loadVerifiedBlobIfSmall(
  meta: BlobMeta,
  blobHash: string,
  sizeBytes: number
): Promise<Buffer | null> {
  if (sizeBytes > INTEGRITY_VERIFY_MAX_BYTES) return null;
  const buf = await readBlob(meta, blobHash);
  const actual = crypto.createHash("sha256").update(buf).digest("hex");
  if (actual !== blobHash) {
    throw new Error(
      `Blob integrity check failed: content hash mismatch for ${blobHash}`
    );
  }
  return buf;
}

/**
 * Delete a blob file from disk. Ignores ENOENT.
 */
export async function deleteBlobFile(fsPath: string): Promise<void> {
  try {
    await fs.unlink(fsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Get the sharded path components for a hash (2-level directory sharding).
 */
function getShardedPath(hash: string): {
  level1: string;
  level2: string;
  filename: string;
} {
  if (hash.length < 4) {
    throw new Error("Hash too short for sharding");
  }
  return {
    level1: hash.slice(0, 2),
    level2: hash.slice(2, 4),
    filename: hash,
  };
}
