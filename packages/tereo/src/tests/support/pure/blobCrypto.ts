import env from "../../../env.js";
import crypto from "crypto";
import {
  BLOB_HEADER_BYTES,
  BLOB_MAGIC_V1,
  type EncryptedBlobKeyMaterial,
  aadForBlobHash,
  checkBlobHeader,
  generateDek,
  unwrapDek,
  wrapDek,
} from "../../../utils/encryption.js";

// AES-GCM's IV and tag sizes, as utils/encryption.ts writes them.
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * In-memory counterpart of `createEncryptStream`: the same on-disk format,
 * `BLOB_MAGIC_V1 || ciphertext || tag`, with the DEK wrapped under AAD =
 * `blobHash` (the caller's sha256 of `plain`).
 */
export function encryptBuffer(
  plain: Buffer,
  blobHash: string
): {
  cipher: Buffer;
  key: EncryptedBlobKeyMaterial;
} {
  const masterKeyVersion = env.FILE_SERVICE_ACTIVE_MASTER_KEY_VERSION;
  const dek = generateDek();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    cipher: Buffer.concat([BLOB_MAGIC_V1, ciphertext, authTag]),
    key: {
      wrappedDek: wrapDek(dek, masterKeyVersion, aadForBlobHash(blobHash)),
      iv,
      masterKeyVersion,
    },
  };
}

/** In-memory counterpart of `createDecryptStream`. */
export function decryptBuffer(
  cipherWithTag: Buffer,
  key: EncryptedBlobKeyMaterial,
  blobHash: string
): Buffer {
  if (cipherWithTag.length < BLOB_HEADER_BYTES + GCM_TAG_BYTES) {
    throw new Error("Encrypted blob is missing magic header");
  }
  checkBlobHeader(cipherWithTag.subarray(0, BLOB_HEADER_BYTES));
  const bodyAndTag = cipherWithTag.subarray(BLOB_HEADER_BYTES);
  const dek = unwrapDek(
    key.wrappedDek,
    key.masterKeyVersion,
    aadForBlobHash(blobHash)
  );
  const ciphertext = bodyAndTag.subarray(0, bodyAndTag.length - GCM_TAG_BYTES);
  const authTag = bodyAndTag.subarray(bodyAndTag.length - GCM_TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", dek, key.iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
