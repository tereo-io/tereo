import { BadRequestError, ForbiddenError } from "./errors.js";
import crypto from "crypto";
import env from "../env.js";

export type PresignOperation = "read" | "write" | "archive";

export interface PresignInput {
  /** Bucket name. For `archive`, this is the bucket the archive is scoped to
   * (the archive id already references it via DB FK, but the HMAC still binds
   * it so tampering the URL to swap buckets fails). */
  bucket: string;
  /** For `read`/`write`: the Object's stable UUID id. For `archive`: the
   * ArchiveRequest id. The HMAC binds this, not any current key, so presigned
   * URLs survive renames (objects) and the URL is the only way to download an
   * archive. */
  id: string;
  operation: PresignOperation;
  expiresInSeconds: number;
  /**
   * Optional share id. When set, the URL carries `&share=<id>` and the HMAC
   * binds it, so the signed-download handlers can look up the share row and
   * refuse to serve a revoked / expired / exhausted share. Use ONLY when
   * minting a URL for a `Share` row; direct presigns must leave this unset
   * so they remain stateless.
   */
  share?: string;
  /**
   * The user minting the URL. Bound by the HMAC and carried as `&by=<id>`, so
   * a write through the URL is attributed to them.
   */
  by?: string;
  /**
   * For `read`: serve this ObjectVersion instead of the current one (a share
   * pinned to a version). Bound by the HMAC and carried as `&version=<id>`.
   */
  version?: string;
  /**
   * For `read`: the download filename, carried as `&filename=` and bound by
   * the HMAC so it can't be swapped for another.
   */
  filename?: string;
}

export interface PresignResult {
  url: string;
  expiresAt: Date;
  operation: PresignOperation;
  /** The URL's random nonce, bound by the HMAC. */
  nonce: string;
}

export interface VerifiedPresign {
  bucket: string;
  id: string;
  operation: PresignOperation;
  expiresAt: Date;
  keyVersion: number;
  nonce: string;
  /** Set iff the URL carried a HMAC-bound `share` parameter. */
  share: string | null;
  /** Set iff the URL carried a HMAC-bound `by` parameter. */
  by: string | null;
  /** Set iff the URL carried a HMAC-bound `version` parameter. */
  version: string | null;
  /** Set iff the URL carried a HMAC-bound `filename`; an unsigned one is dropped. */
  filename: string | null;
}

function getSigningKey(version: number): Buffer {
  const envKey = `FILE_SERVICE_SIGNING_KEY_V${version}` as keyof typeof env;
  const raw = env[envKey] as string | undefined;
  if (!raw) {
    throw new ForbiddenError(
      `Signing key version ${version} is not configured`
    );
  }
  return Buffer.from(raw, "base64");
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function canonicalString(
  bucket: string,
  id: string,
  operation: PresignOperation,
  expiresAt: number,
  nonce: string,
  keyVersion: number,
  share: string | null,
  by: string | null,
  version: string | null,
  filename: string | null
): string {
  const parts: (string | number)[] = [
    bucket,
    id,
    operation,
    expiresAt,
    nonce,
    `v${keyVersion}`,
  ];
  // Only append the share segment when present — preserves the canonical
  // shape of the existing presigned-URL fleet so older URLs without `share`
  // continue to verify under the original tuple.
  if (share) parts.push(`share=${share}`);
  if (by) parts.push(`by=${by}`);
  if (version) parts.push(`version=${version}`);
  // Encoded, so a `|` in a filename can't forge another segment.
  if (filename) parts.push(`filename=${encodeURIComponent(filename)}`);
  return parts.join("|");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^\d+$/;
const NONCE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The canonical string joins fields with `|` and parses the numbers, so a
 * parameter outside its shape (`share=a|by=b`, `expires=123abc`) could carry
 * a signature over a different tuple. Nothing `sign()` emits fails this.
 */
function wellFormed(params: {
  expires: string;
  nonce: string;
  v: string;
  share: string | null;
  by: string | null;
  version: string | null;
}): boolean {
  return (
    DIGITS.test(params.expires) &&
    DIGITS.test(params.v) &&
    NONCE.test(params.nonce) &&
    [params.share, params.by, params.version].every(
      (id) => id === null || UUID.test(id)
    )
  );
}

function hmac(key: Buffer, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * Throws the same 400 `sign()` would for an out-of-range TTL, so a caller that
 * writes rows before signing can reject the request before writing anything.
 */
export function assertPresignTtl(expiresInSeconds: number): void {
  if (expiresInSeconds <= 0) {
    throw new BadRequestError(
      "invalid_expiration",
      "expiresInSeconds must be > 0"
    );
  }
  const max = env.FILE_SERVICE_MAX_PRESIGN_TTL_SECONDS;
  if (expiresInSeconds > max) {
    throw new BadRequestError(
      "invalid_expiration",
      `expiresInSeconds must be <= ${max}`
    );
  }
}

export function sign(input: PresignInput): PresignResult {
  const { bucket, id, operation, expiresInSeconds } = input;
  assertPresignTtl(expiresInSeconds);

  const keyVersion = env.FILE_SERVICE_ACTIVE_SIGNING_KEY_VERSION;
  const signingKey = getSigningKey(keyVersion);
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const nonce = base64UrlEncode(crypto.randomBytes(9));
  const share = input.share ?? null;
  const by = input.by ?? null;
  const version = input.version ?? null;
  const filename = input.filename ?? null;
  const canon = canonicalString(
    bucket,
    id,
    operation,
    expiresAt,
    nonce,
    keyVersion,
    share,
    by,
    version,
    filename
  );
  const sig = base64UrlEncode(hmac(signingKey, canon));

  // Archive URLs address the ArchiveRequest id directly — the bucket is
  // already bound in the HMAC and resolved by the DB lookup, so it stays out
  // of the URL path. Object read/write URLs keep the bucket in the path for
  // continuity with the pre-archive signed route shape.
  const path =
    operation === "archive"
      ? `/signed/archives/${id}`
      : `/signed/objects/${encodeURIComponent(bucket)}/by-id/${id}`;
  const query = new URLSearchParams({
    op: operation,
    expires: String(expiresAt),
    nonce,
    v: String(keyVersion),
    sig,
  });
  if (share) query.set("share", share);
  if (by) query.set("by", by);
  if (version) query.set("version", version);
  if (filename) query.set("filename", filename);
  const url = `${env.FILE_SERVICE_PUBLIC_BASE_URL}${path}?${query.toString()}`;

  return { url, expiresAt: new Date(expiresAt * 1000), operation, nonce };
}

export function verify(params: {
  bucket: string;
  id: string;
  operation: PresignOperation;
  expires: string;
  nonce: string;
  v: string;
  sig: string;
  /** Optional `share=<id>` from the URL. Bound into the HMAC when present so a
   * caller cannot strip the share id and bypass the share-state check. */
  share?: string | null;
  /** Optional `by=<user id>` from the URL, bound into the HMAC when present. */
  by?: string | null;
  /** Optional `version=<version id>` from the URL, bound when present. */
  version?: string | null;
  /** Optional `filename` from the URL. Kept only when the HMAC binds it. */
  filename?: string | null;
}): VerifiedPresign {
  const { bucket, id, operation, expires, nonce, v, sig } = params;
  const share = params.share ?? null;
  const by = params.by ?? null;
  const version = params.version ?? null;

  if (!wellFormed({ expires, nonce, v, share, by, version })) {
    throw new ForbiddenError("Invalid signature");
  }
  const keyVersion = Number.parseInt(v, 10);
  if (!Number.isInteger(keyVersion) || keyVersion <= 0) {
    throw new ForbiddenError("Invalid signing key version");
  }
  const expiresAt = Number.parseInt(expires, 10);
  if (!Number.isInteger(expiresAt)) {
    throw new ForbiddenError("Invalid expiration");
  }
  // Allow a small skew window so a client whose clock is slightly ahead of the
  // server (or vice versa) does not hit a spurious 403 right at the TTL edge.
  const skewMs = env.FILE_SERVICE_PRESIGN_CLOCK_SKEW_SECONDS * 1000;
  if (expiresAt * 1000 + skewMs < Date.now()) {
    throw new ForbiddenError("Signed URL expired");
  }

  const signingKey = getSigningKey(keyVersion);
  const matches = (filename: string | null) => {
    const canon = canonicalString(
      bucket,
      id,
      operation,
      expiresAt,
      nonce,
      keyVersion,
      share,
      by,
      version,
      filename
    );
    // Compare in the base64-url encoding the client sent, not the decoded
    // bytes. A 32-byte HMAC encodes to 43 unpadded base64 chars where the
    // last character carries only 4 significant bits — the remaining 2 bits
    // are discarded on decode. Byte-level comparison would therefore accept
    // three variants of the final character as equivalent, making the
    // signature malleable (and tamper-detection tests flaky ~1/16 of runs).
    const expected = Buffer.from(
      base64UrlEncode(hmac(signingKey, canon)),
      "utf8"
    );
    const provided = Buffer.from(sig, "utf8");
    return (
      expected.length === provided.length &&
      crypto.timingSafeEqual(expected, provided)
    );
  };

  // A `filename` the signature doesn't cover was added after signing (or the
  // URL predates signed filenames): it is ignored, not honored.
  const offered = params.filename || null;
  let filename: string | null = null;
  if (offered && matches(offered)) {
    filename = offered;
  } else if (!matches(null)) {
    throw new ForbiddenError("Invalid signature");
  }

  return {
    bucket,
    id,
    operation,
    expiresAt: new Date(expiresAt * 1000),
    keyVersion,
    nonce,
    share,
    by,
    version,
    filename,
  };
}
