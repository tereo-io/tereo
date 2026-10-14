import { getMasterKey } from "./masterKeys.js";
import { Transform } from "stream";
import crypto from "crypto";
import env from "../env.js";

const DEK_BYTES = 32;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const WRAPPED_DEK_IV_BYTES = 12;

// Magic prefix written at the start of every blob file. Lets file-system
// forensics tools identify the format and gives readers an unambiguous failure
// when the file isn't one of ours. Five bytes: 'V','F','B','E', <version>.
//
// Header is split into a 4-byte ASCII tag + a 1-byte version. Readers verify
// the tag, then check the version against MAX_BLOB_VERSION — that way a future
// v2 file surfaces an explicit "unsupported version" rather than a generic
// "invalid magic header" that looks like corruption.
const BLOB_MAGIC_TAG = Buffer.from([0x56, 0x46, 0x42, 0x45]);
const BLOB_TAG_BYTES = BLOB_MAGIC_TAG.length;
const BLOB_VERSION_BYTES = 1;
const BLOB_VERSION_V1 = 0x01;
const MAX_BLOB_VERSION = BLOB_VERSION_V1;
export const BLOB_HEADER_BYTES = BLOB_TAG_BYTES + BLOB_VERSION_BYTES;
export const BLOB_MAGIC_V1 = Buffer.concat([
  BLOB_MAGIC_TAG,
  Buffer.from([BLOB_VERSION_V1]),
]);

function readBlobHeader(buf: Buffer): void {
  if (!buf.subarray(0, BLOB_TAG_BYTES).equals(BLOB_MAGIC_TAG)) {
    throw new Error("Encrypted blob has invalid magic header");
  }
  const version = buf[BLOB_TAG_BYTES];
  if (version === undefined || version > MAX_BLOB_VERSION) {
    throw new Error(`Encrypted blob has unsupported version ${version}`);
  }
}

export interface EncryptedBlobKeyMaterial {
  wrappedDek: Buffer;
  iv: Buffer;
  masterKeyVersion: number;
}

export function generateDek(): Buffer {
  return crypto.randomBytes(DEK_BYTES);
}

/**
 * Wrap a DEK with a master key. AAD binds the wrapped DEK to its context —
 * the blob hash for ContentBlob, the upload id for staging DEKs — so a
 * wrapped DEK from one row cannot be transplanted onto another.
 */
export function wrapDek(
  dek: Buffer,
  masterKeyVersion: number,
  aad: Buffer
): Buffer {
  const masterKey = getMasterKey(masterKeyVersion);
  const iv = crypto.randomBytes(WRAPPED_DEK_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function unwrapDek(
  wrapped: Buffer,
  masterKeyVersion: number,
  aad: Buffer
): Buffer {
  // Wrap layout is iv(12) || tag(16) || ciphertext(>=1). Anything shorter
  // can only be DB corruption or tampering — surface that explicitly rather
  // than letting the GCM library throw an opaque "Unsupported state" error
  // when one of the subarray slices comes back empty.
  const minBytes = WRAPPED_DEK_IV_BYTES + GCM_TAG_BYTES + 1;
  if (wrapped.length < minBytes) {
    throw new Error(
      `Wrapped DEK truncated: expected at least ${minBytes} bytes, got ${wrapped.length}`
    );
  }
  const masterKey = getMasterKey(masterKeyVersion);
  const iv = wrapped.subarray(0, WRAPPED_DEK_IV_BYTES);
  const authTag = wrapped.subarray(
    WRAPPED_DEK_IV_BYTES,
    WRAPPED_DEK_IV_BYTES + GCM_TAG_BYTES
  );
  const ciphertext = wrapped.subarray(WRAPPED_DEK_IV_BYTES + GCM_TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * AAD bytes binding a wrapped DEK to its content blob. The hash is hex in
 * the DB; AAD is the underlying bytes.
 */
export function aadForBlobHash(blobHash: string): Buffer {
  return Buffer.from(blobHash, "hex");
}

/**
 * AAD bytes binding a multipart staging DEK to its upload row.
 */
export function aadForUploadId(uploadId: string): Buffer {
  return Buffer.from(uploadId, "utf8");
}

/**
 * Streaming cipher that emits `BLOB_MAGIC_V1 || ciphertext || tag`. The DEK
 * is wrapped *after* the stream finishes — the caller must invoke
 * `finalize(blobHash)` with the plaintext SHA-256, which becomes the AAD
 * bound to the wrapped DEK.
 *
 * Ordering: pipe `stream` to a sink, await the pipeline, then call
 * `finalize(hash)` with the hash you computed alongside the encryption.
 */
export function createEncryptStream(): {
  stream: Transform;
  finalize: (blobHash: string) => EncryptedBlobKeyMaterial;
} {
  const masterKeyVersion = env.FILE_SERVICE_ACTIVE_MASTER_KEY_VERSION;
  const dek = generateDek();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", dek, iv);

  let magicEmitted = false;

  const stream = new Transform({
    transform(chunk, _enc, cb) {
      try {
        const out = cipher.update(chunk);
        if (!magicEmitted) {
          magicEmitted = true;
          this.push(BLOB_MAGIC_V1);
        }
        cb(null, out);
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        if (!magicEmitted) {
          magicEmitted = true;
          this.push(BLOB_MAGIC_V1);
        }
        this.push(cipher.final());
        this.push(cipher.getAuthTag());
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });

  let finalized = false;
  return {
    stream,
    finalize: (blobHash: string) => {
      if (finalized) {
        throw new Error("createEncryptStream: finalize() called twice");
      }
      finalized = true;
      return {
        wrappedDek: wrapDek(dek, masterKeyVersion, aadForBlobHash(blobHash)),
        iv,
        masterKeyVersion,
      };
    },
  };
}

/**
 * Streaming decipher for blobs written by `createEncryptStream`. Validates
 * the leading `BLOB_MAGIC_V1` before unwrapping the DEK with AAD = blobHash.
 * A wrong hash, missing magic, or truncated tag all raise on `flush`.
 */
export function createDecryptStream(
  key: EncryptedBlobKeyMaterial,
  blobHash: string
): Transform {
  const dek = unwrapDek(
    key.wrappedDek,
    key.masterKeyVersion,
    aadForBlobHash(blobHash)
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", dek, key.iv);

  let headerRemaining = BLOB_HEADER_BYTES;
  let headerCheckBuf = Buffer.alloc(0);
  // Buffer the trailing GCM_TAG_BYTES so we can pull the tag off on flush.
  let carry = Buffer.alloc(0);

  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        let body: Buffer = chunk;
        if (headerRemaining > 0) {
          headerCheckBuf = Buffer.concat([headerCheckBuf, body]);
          if (headerCheckBuf.length < BLOB_HEADER_BYTES) {
            return cb();
          }
          readBlobHeader(headerCheckBuf.subarray(0, BLOB_HEADER_BYTES));
          body = headerCheckBuf.subarray(BLOB_HEADER_BYTES);
          headerRemaining = 0;
          headerCheckBuf = Buffer.alloc(0);
        }
        const combined = Buffer.concat([carry, body]);
        if (combined.length <= GCM_TAG_BYTES) {
          carry = combined;
          return cb();
        }
        const toDecipher = combined.subarray(
          0,
          combined.length - GCM_TAG_BYTES
        );
        carry = combined.subarray(combined.length - GCM_TAG_BYTES);
        cb(null, decipher.update(toDecipher));
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        if (headerRemaining > 0) {
          return cb(
            new Error("Encrypted blob truncated: missing magic header")
          );
        }
        if (carry.length !== GCM_TAG_BYTES) {
          return cb(new Error("Encrypted blob truncated: missing auth tag"));
        }
        decipher.setAuthTag(carry);
        cb(null, decipher.final());
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

const AES_BLOCK_BYTES = 16;

/**
 * The most plaintext one blob can hold: a blob is one AES-256-GCM stream,
 * whose 32-bit block counter starts at 2 for the data (see
 * `createRangeDecipher`), so 2^32 - 2 blocks of 16 bytes — 32 bytes short of
 * 64 GiB. Only multipart uploads can approach it.
 */
export const MAX_BLOB_BYTES = (2n ** 32n - 2n) * BigInt(AES_BLOCK_BYTES);

/**
 * Decrypt part of a blob written by `createEncryptStream`, starting at
 * plaintext byte `start`, without reading what comes before it.
 *
 * GCM encrypts with AES-CTR: plaintext block `b` is XORed with the keystream
 * for counter block `iv || uint32be(2 + b)` (a 96-bit IV starts the count at
 * 1 for the tag, then 2). So an AES-256-CTR decipher seeded with that counter
 * decrypts from block `b` on. Returns the decipher, the file offset of block
 * `b`'s ciphertext, and how many leading plaintext bytes to drop to reach
 * `start`.
 *
 * The GCM tag covers the whole ciphertext, so a range is not authenticated:
 * callers that need that read the whole blob (`loadVerifiedBlobIfSmall`).
 */
export function createRangeDecipher(
  key: EncryptedBlobKeyMaterial,
  blobHash: string,
  start: number
): { decipher: crypto.Decipheriv; fileOffset: number; skip: number } {
  if (key.iv.length !== IV_BYTES) {
    throw new Error(`Blob IV must be ${IV_BYTES} bytes to seek`);
  }
  const dek = unwrapDek(
    key.wrappedDek,
    key.masterKeyVersion,
    aadForBlobHash(blobHash)
  );
  const block = Math.floor(start / AES_BLOCK_BYTES);
  const counter = Buffer.alloc(AES_BLOCK_BYTES);
  key.iv.copy(counter, 0);
  counter.writeUInt32BE(2 + block, IV_BYTES);
  return {
    decipher: crypto.createDecipheriv("aes-256-ctr", dek, counter),
    fileOffset: BLOB_HEADER_BYTES + block * AES_BLOCK_BYTES,
    skip: start - block * AES_BLOCK_BYTES,
  };
}

/** Throws unless `header` is a supported blob file header. */
export function checkBlobHeader(header: Buffer): void {
  if (header.length < BLOB_HEADER_BYTES) {
    throw new Error("Encrypted blob truncated: missing magic header");
  }
  readBlobHeader(header);
}

/**
 * Generate + wrap a per-multipart-upload staging DEK. AAD = uploadId.
 */
export function generateStagingDek(uploadId: string): {
  wrapped: Buffer;
  masterKeyVersion: number;
} {
  const masterKeyVersion = env.FILE_SERVICE_ACTIVE_MASTER_KEY_VERSION;
  const dek = generateDek();
  const wrapped = wrapDek(dek, masterKeyVersion, aadForUploadId(uploadId));
  return { wrapped, masterKeyVersion };
}

/**
 * Encrypt a multipart part stream under the upload's staging DEK. On-disk
 * format: `iv(12) || ciphertext || tag(16)`. Fresh per-part IV so reusing
 * the same DEK across parts is safe. No magic header — parts are internal
 * scratch, swept after TTL.
 */
export function createMultipartPartEncryptStream(
  stagingDek: Buffer
): Transform {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", stagingDek, iv);
  let ivEmitted = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        const out = cipher.update(chunk);
        if (!ivEmitted) {
          ivEmitted = true;
          this.push(iv);
        }
        cb(null, out);
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        if (!ivEmitted) {
          ivEmitted = true;
          this.push(iv);
        }
        this.push(cipher.final());
        this.push(cipher.getAuthTag());
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

/**
 * Decrypt a multipart part stream produced by
 * `createMultipartPartEncryptStream`. Reads the leading 12-byte IV and
 * trailing 16-byte tag.
 */
export function createMultipartPartDecryptStream(
  stagingDek: Buffer
): Transform {
  let ivRemaining = IV_BYTES;
  let ivBuf = Buffer.alloc(0);
  let decipher: crypto.DecipherGCM | null = null;
  let carry = Buffer.alloc(0);

  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        let body: Buffer = chunk;
        if (ivRemaining > 0) {
          ivBuf = Buffer.concat([ivBuf, body]);
          if (ivBuf.length < IV_BYTES) {
            return cb();
          }
          const iv = ivBuf.subarray(0, IV_BYTES);
          decipher = crypto.createDecipheriv(
            "aes-256-gcm",
            stagingDek,
            iv
          ) as crypto.DecipherGCM;
          body = ivBuf.subarray(IV_BYTES);
          ivRemaining = 0;
          ivBuf = Buffer.alloc(0);
        }
        const combined = Buffer.concat([carry, body]);
        if (combined.length <= GCM_TAG_BYTES) {
          carry = combined;
          return cb();
        }
        const toDecipher = combined.subarray(
          0,
          combined.length - GCM_TAG_BYTES
        );
        carry = combined.subarray(combined.length - GCM_TAG_BYTES);
        cb(null, decipher!.update(toDecipher));
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        if (ivRemaining > 0) {
          return cb(new Error("Multipart part truncated: missing IV header"));
        }
        if (!decipher) {
          return cb(new Error("Multipart part truncated: no body"));
        }
        if (carry.length !== GCM_TAG_BYTES) {
          return cb(new Error("Multipart part truncated: missing auth tag"));
        }
        decipher.setAuthTag(carry);
        cb(null, decipher.final());
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}
