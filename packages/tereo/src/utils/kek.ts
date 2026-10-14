import { logger } from "./logger.js";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";

/**
 * The key-encryption key (KEK) that wraps every value in `core.secrets`.
 *
 * A provider wraps and unwraps opaque bytes; `context` (the secret's name) is
 * bound to the ciphertext, so a value cannot be moved to another row. Both
 * calls are async so a KMS-backed provider fits behind the same interface;
 * such a provider belongs in dianemo-plugins and would be returned by
 * `resolveKek()` in place of the env one.
 */
export interface KeyEncryptionKey {
  /** Stored with every wrapped value: which KEK can open it. `[a-z0-9-]+`. */
  readonly id: string;
  wrap(plaintext: Buffer, context: string): Promise<Buffer>;
  unwrap(wrapped: Buffer, context: string): Promise<Buffer>;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM under a local key: `iv || tag || ciphertext`. */
export const aesGcmKek = (key: Buffer, id: string): KeyEncryptionKey => {
  if (key.length !== 32) throw new Error("A KEK must be 32 bytes");
  return {
    id,
    wrap: async (plaintext, context) => {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    unwrap: async (wrapped, context) => {
      if (wrapped.length < IV_BYTES + TAG_BYTES) {
        throw new Error("Wrapped value is truncated");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        wrapped.subarray(0, IV_BYTES)
      );
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(wrapped.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
    },
  };
};

/** A stable, non-reversible id for a local KEK. */
export const kekIdOf = (key: Buffer): string =>
  "env-" +
  createHash("sha256")
    .update("tereo KEK id\0")
    .update(key)
    .digest("hex")
    .slice(0, 16);

// Derived from a constant rather than generated into a file: a lost or
// mismatched file would leave the dev database's secrets unreadable, while a
// constant needs no state and works the same in the compose stack, the test
// stack and `npm run dev`. It protects nothing — the constant is public — so
// values wrapped with it are treated like plaintext and re-wrapped as soon as
// a real CORE_KEK is configured.
export const DEV_KEK_ID = "dev";
export const devKek = aesGcmKek(
  createHash("sha256").update("tereo development KEK; not a secret").digest(),
  DEV_KEK_ID
);

/**
 * The KEK this process uses: `CORE_KEK` when set, otherwise (outside
 * production only; env.ts refuses a missing one in production) the dev KEK.
 */
const envKek = (base64: string): KeyEncryptionKey => {
  const key = Buffer.from(base64, "base64");
  return aesGcmKek(key, kekIdOf(key));
};

export const resolveKek = (config: {
  CORE_KEK?: string;
  NODE_ENV: string;
}): KeyEncryptionKey => {
  if (config.CORE_KEK) return envKek(config.CORE_KEK);
  if (config.NODE_ENV === "production") {
    throw new Error("CORE_KEK is required in production");
  }
  logger.warn(
    "CORE_KEK is not set: core.secrets is encrypted with the built-in " +
      "development KEK, which is public and protects nothing. Set CORE_KEK " +
      "(openssl rand -base64 32) before storing anything real; production " +
      "refuses to start without it."
  );
  return devKek;
};

/**
 * `CORE_KEK_PREVIOUS`, during a KEK rotation: rows still under it are opened
 * and re-wrapped under `CORE_KEK` on start.
 */
export const resolvePreviousKek = (config: {
  CORE_KEK_PREVIOUS?: string;
}): KeyEncryptionKey | undefined =>
  config.CORE_KEK_PREVIOUS ? envKek(config.CORE_KEK_PREVIOUS) : undefined;

const ENVELOPE_PREFIX = "kek1";

/** How every value sealed under `kek` starts. */
export const sealedPrefix = (kek: KeyEncryptionKey): string =>
  `${ENVELOPE_PREFIX}:${kek.id}:`;

/** `kek1:<kek id>:<base64url payload>` — never a valid plaintext key. */
export const sealSecret = async (
  kek: KeyEncryptionKey,
  name: string,
  value: string
): Promise<string> => {
  const wrapped = await kek.wrap(Buffer.from(value, "utf8"), name);
  return `${ENVELOPE_PREFIX}:${kek.id}:${wrapped.toString("base64url")}`;
};

export interface OpenedSecret {
  value: string;
  /**
   * Stored as plaintext, under the dev KEK or under the previous KEK:
   * re-wrap it under `kek`.
   */
  rewrap: boolean;
}

/**
 * The plaintext of a stored value. Stored keys are PEM, hex or base64, none
 * of which contains a colon, so anything without the envelope prefix is a
 * row from before the KEK existed.
 *
 * With `refuseUnsealed` (production), a plaintext row or one under the public
 * dev KEK is refused rather than adopted: anyone who can write the table
 * could otherwise plant a key that every replica picks up.
 */
export const openSecret = async (
  kek: KeyEncryptionKey,
  name: string,
  stored: string,
  previous?: KeyEncryptionKey,
  refuseUnsealed = false
): Promise<OpenedSecret> => {
  if (!stored.startsWith(`${ENVELOPE_PREFIX}:`)) {
    if (refuseUnsealed) {
      throw new Error(
        `core.secrets "${name}" is stored unencrypted, which production refuses. Delete the row (core regenerates generated keys) or seal it under CORE_KEK.`
      );
    }
    return { value: stored, rewrap: true };
  }
  const [, id, payload] = stored.split(":");
  if (refuseUnsealed && id === devKek.id && kek !== devKek) {
    throw new Error(
      `core.secrets "${name}" is encrypted with the public development KEK, which production refuses. Delete the row (core regenerates generated keys) or seal it under CORE_KEK.`
    );
  }
  const opener = [kek, previous, devKek].find((k) => k?.id === id);
  if (!opener || payload === undefined) {
    const known = previous ? `${kek.id} (and previous ${previous.id})` : kek.id;
    throw new Error(
      `core.secrets "${name}" is encrypted with KEK ${id}, but this process ` +
        `has KEK ${known}. Start core with the CORE_KEK it was written with, ` +
        `or set it as CORE_KEK_PREVIOUS to re-encrypt under the new one.`
    );
  }
  let plaintext: Buffer;
  try {
    plaintext = await opener.unwrap(Buffer.from(payload, "base64url"), name);
  } catch {
    throw new Error(
      `core.secrets "${name}" could not be decrypted with KEK ${id}: the row is corrupt or was moved from another name`
    );
  }
  return { value: plaintext.toString("utf8"), rewrap: opener !== kek };
};
