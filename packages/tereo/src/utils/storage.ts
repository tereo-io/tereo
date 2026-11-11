import { Readable, Transform, pipeline as pipelineCb } from "stream";
import { blobStore } from "./blobStore/index.js";
import { ByteBudget } from "./byteBudget.js";
import { promisify } from "util";
import crypto from "crypto";
import env from "../env.js";
import {
  ScratchKind,
  createScratchFile,
  discardScratchFile,
  ensureScratchDir,
} from "./scratchFiles.js";
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
 * An encrypted blob written to a scratch file (`stagedPath`), not yet at its
 * content-addressed location (`fsPath`, the blob store's). `contentBlobs.attach`
 * places it there only when its write creates the `ContentBlob` row; otherwise
 * the existing row and blob are shared and the staged file is dropped.
 */
export interface SaveBlobResult {
  hash: string;
  etag: string;
  fsPath: string;
  sizeBytes: number;
  stagedPath: string;
  keyMaterial: EncryptedBlobKeyMaterial;
  /** The leading plaintext bytes asked for with `sniffBytes`; empty without. */
  head: Buffer;
}

export interface SaveBlobOptions {
  /** Names the scratch file. */
  kind?: ScratchKind;
  /** Plaintext size past which the save fails with `tooLarge()`. */
  maxBytes?: number;
  tooLarge?: () => Error;
  /** How many leading plaintext bytes to return as `head`. */
  sniffBytes?: number;
}

/** `fsPath` is the blob's location in the blob store (`content_blobs.fs_path`). */
export interface BlobMeta {
  fsPath: string;
  keyMaterial: EncryptedBlobKeyMaterial;
}

export async function ensureBlobDirectory(): Promise<void> {
  await blobStore.ensureReady();
}

export async function ensureTempDirectory(): Promise<void> {
  await ensureScratchDir();
}

export function getBlobPath(hash: string): string {
  return blobStore.locationFor(hash);
}

export async function removeMultipartDir(uploadId: string): Promise<void> {
  await blobStore.removeUpload(uploadId);
}

export async function placeBlobFile(
  stagedPath: string,
  targetPath: string
): Promise<void> {
  await blobStore.place(stagedPath, targetPath);
}

export async function discardStagedFile(stagedPath: string): Promise<void> {
  await discardScratchFile(stagedPath);
}

/**
 * Stage a multipart part **encrypted** under the upload's staging DEK.
 *
 * Stored layout per part: `iv(12) || ciphertext || tag(16)` — the IV is
 * fresh per part so reusing the same DEK across parts of one upload is safe.
 * The hash, etag, and size returned here are all over the *plaintext* (so the
 * S3-compatible per-part MD5 etag and the dedup-hint SHA-256 stay
 * content-addressed). `sizeBytes` is plaintext length; the stored part is
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
  // A failure upstream destroys the ciphertext stream with its error, which
  // the store's write then rejects with, having stored nothing.
  const ciphertext = pipelineCb(source, meter, partCipher, () => {});
  // Each stage gets a location of its own; the DB upsert decides which one
  // wins, and the controller deletes the prior one (if any) after it.
  const fsPath = await blobStore.writePart(uploadId, partNumber, ciphertext);
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
  // pipeline, not pipe: a read error (a missing part) reaches the reader.
  pipelineCb(blobStore.openPart(fsPath), decrypt, () => {});
  return decrypt;
}

/**
 * Save a plaintext stream as an encrypted content-addressed blob.
 *
 * The SHA-256 is computed over the PLAINTEXT so dedup is content-based.
 * The stored blob (v1 format) is `BLOB_MAGIC_V1 || ciphertext || tag(16)`.
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
  source: Readable,
  options: SaveBlobOptions = {}
): Promise<SaveBlobResult> {
  // Hash the plaintext by tee-ing the stream through a SHA-256 while we also
  // feed an encrypted copy into a scratch file. We can't know the final hash
  // until the stream ends, so the blob is placed only once we know.
  const { maxBytes, tooLarge, sniffBytes = 0 } = options;
  const scratch = await createScratchFile(options.kind ?? "upload");

  const plaintextHasher = crypto.createHash("sha256");
  const md5Hasher = crypto.createHash("md5");
  let plaintextSize = 0;
  const headChunks: Buffer[] = [];
  let headBytes = 0;

  const plaintextMeter = new Transform({
    transform(chunk, _enc, cb) {
      plaintextSize += chunk.length;
      if (maxBytes !== undefined && plaintextSize > maxBytes) {
        return cb(tooLarge ? tooLarge() : new Error("Upload exceeds max size"));
      }
      plaintextHasher.update(chunk);
      md5Hasher.update(chunk);
      if (headBytes < sniffBytes) {
        const need = sniffBytes - headBytes;
        const slice = chunk.length > need ? chunk.subarray(0, need) : chunk;
        headChunks.push(Buffer.from(slice));
        headBytes += slice.length;
      }
      cb(null, chunk);
    },
  });

  const { stream: encryptStream, finalize } = createEncryptStream();

  try {
    await pipeline(source, plaintextMeter, encryptStream, scratch.stream);
  } catch (err) {
    await discardScratchFile(scratch.path).catch(() => {});
    throw err;
  }

  const hash = plaintextHasher.digest("hex");
  return {
    hash,
    etag: md5Hasher.digest("hex"),
    fsPath: blobStore.locationFor(hash),
    sizeBytes: plaintextSize,
    stagedPath: scratch.path,
    keyMaterial: finalize(hash),
    head: Buffer.concat(headChunks),
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
  const fileStream = blobStore.openRead(meta.fsPath);
  const decrypt = createDecryptStream(meta.keyMaterial, blobHash);
  // Not `.pipe`: destroying the returned stream must close the file too, and
  // a read error must surface on it. Errors reach callers through `decrypt`.
  return pipelineCb(fileStream, decrypt, () => {});
}

/**
 * Plaintext bytes `start`..`end` (inclusive) of an encrypted blob, read from
 * the middle of the blob rather than decrypting everything before `start`
 * (see `createRangeDecipher`). Not authenticated by the GCM tag.
 */
export async function openBlobRangeStream(
  meta: BlobMeta,
  blobHash: string,
  start: number,
  end: number
): Promise<Readable> {
  await assertBlobReadable(meta.fsPath);
  const { decipher, fileOffset, skip } = createRangeDecipher(
    meta.keyMaterial,
    blobHash,
    start
  );
  const file = blobStore.openRead(meta.fsPath, {
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

export const verifiedReadBudget = new ByteBudget(
  env.FILE_SERVICE_VERIFIED_READ_BUDGET_MB * 1024 * 1024,
  env.FILE_SERVICE_VERIFIED_READ_WAIT_SECONDS * 1000
);

export interface VerifiedBlob {
  buffer: Buffer;
  /** Returns the buffer's bytes to the verified-read budget. Idempotent. */
  release: () => void;
}

export interface ByteRange {
  start: number;
  /** Inclusive. */
  end: number;
}

/**
 * For blobs small enough to buffer (<= INTEGRITY_VERIFY_MAX_BYTES), return the
 * fully decrypted plaintext only after verifying it end-to-end: `readBlob`
 * runs GCM authentication, and we additionally re-hash the plaintext and
 * compare it to the content address. Returns null for larger blobs (caller
 * should stream). THROWS on any integrity failure — callers MUST await this
 * BEFORE writing response headers/body so a tampered blob produces a clean
 * error instead of a forged, complete-looking download.
 *
 * The plaintext counts against a process-wide budget
 * (`FILE_SERVICE_VERIFIED_READ_BUDGET_MB`) until the caller calls `release`,
 * once the buffer has been sent; a read that finds no room in time is a 503.
 *
 * With `range`, the buffer is a copy of those bytes alone and, once the whole
 * blob is verified, only they stay charged.
 */
export async function loadVerifiedBlobIfSmall(
  meta: BlobMeta,
  blobHash: string,
  sizeBytes: number,
  range?: ByteRange
): Promise<VerifiedBlob | null> {
  if (sizeBytes > INTEGRITY_VERIFY_MAX_BYTES) return null;
  const release = await verifiedReadBudget.acquire(sizeBytes);
  try {
    const buffer = await readBlob(meta, blobHash);
    const actual = crypto.createHash("sha256").update(buffer).digest("hex");
    if (actual !== blobHash) {
      throw new Error(
        `Blob integrity check failed: content hash mismatch for ${blobHash}`
      );
    }
    if (!range) return { buffer, release };
    const slice = Buffer.from(buffer.subarray(range.start, range.end + 1));
    release.shrinkTo(slice.length);
    return { buffer: slice, release };
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * Throws unless the blob is there and starts with a blob header, so a
 * missing or foreign one is caught before its stream is handed on.
 */
export async function assertBlobReadable(location: string): Promise<void> {
  checkBlobHeader(await blobStore.readHead(location, BLOB_HEADER_BYTES));
}

export const assertBlobFileReadable = assertBlobReadable;

export async function deleteBlobFile(fsPath: string): Promise<void> {
  await blobStore.delete(fsPath);
}
