import type { ObjectWithCurrent } from "../../../../../../utils/db/objects.js";
import { getAccessibleBucket } from "../../../../../../utils/bucketAccess.js";
import { normalizeContentType } from "../../../../../../utils/contentType.js";
import { isThumbnailSource } from "../../../../../../utils/thumbnails.js";
import type { AuthContext } from "../../../../../../middleware/auth.js";
import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";
import type { UserRef } from "../../../../../../utils/refs.js";
import { logger } from "../../../../../../utils/logger.js";
import { metadataSchema } from "./schemas.js";
import { Request, Response } from "express";
import fs from "fs/promises";
import {
  ifRangeAllows,
  parseRange,
} from "../../../../../../utils/httpRange.js";
import {
  loadVerifiedBlobIfSmall,
  openBlobRangeStream,
  openBlobStream,
} from "../../../../../../utils/storage.js";
import {
  AppError,
  BadRequestError,
  NotFoundError,
  sendError,
} from "../../../../../../utils/errors.js";
import {
  enqueueOrphanBlobCleanupSafe,
  enqueueThumbnailGeneration,
} from "../../../../../../jobs/index.js";

// Maximum metadata header size (100KB)
const MAX_METADATA_HEADER_SIZE = 100 * 1024;

// Dangerous file types that should be blocked (by extension)
const BLOCKED_EXTENSIONS = new Set([
  "exe",
  "dll",
  "bat",
  "cmd",
  "com",
  "scr",
  "msi",
  "sh",
  "bash",
  "app",
  "dmg",
  "deb",
  "rpm",
  "apk",
  "jar",
  "war",
]);

// Dangerous MIME types that should be blocked
const BLOCKED_MIME_TYPES = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-executable",
  "application/x-sh",
  "application/x-bash",
  "text/x-shellscript",
  "application/x-apple-diskimage",
  "application/vnd.microsoft.portable-executable",
  "application/x-deb",
  "application/x-redhat-package-manager",
  "application/vnd.android.package-archive",
  "application/java-archive",
]);

// Safe text-based MIME types (for files that file-type cannot detect)
const ALLOWED_TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/html",
  "text/css",
  "text/javascript",
  "text/markdown",
  "text/xml",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "text/yaml",
  "application/csv",
  "application/ld+json",
  "application/geo+json",
  "application/vnd.api+json",
]);

export interface MimeSource {
  buffer?: Buffer;
  path?: string;
  mimetype: string;
}

// Sniff the first 8KB of a file to decide whether it looks like text. A single
// NUL byte in the leading window is treated as definitive binary — the same
// heuristic git and file(1) use. Executables without magic bytes are rare, and
// nearly all real-world binaries hit a NUL byte within the first few KB.
const TEXT_SNIFF_BYTES = 8192;

const looksLikeText = async (file: MimeSource): Promise<boolean> => {
  let sample: Buffer;
  if (file.buffer) {
    sample = file.buffer.subarray(0, TEXT_SNIFF_BYTES);
  } else if (file.path) {
    const handle = await fs.open(file.path, "r");
    try {
      const buf = Buffer.alloc(TEXT_SNIFF_BYTES);
      const { bytesRead } = await handle.read(buf, 0, TEXT_SNIFF_BYTES, 0);
      sample = buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } else {
    return false;
  }
  return !sample.includes(0);
};

/**
 * Validate uploaded file MIME type for security
 *
 * Security model:
 * - Binary files: Use file-type library to detect actual type from magic bytes,
 *   then validate against BLOCKED_EXTENSIONS and BLOCKED_MIME_TYPES
 * - Text files: file-type cannot detect these, so fall back to the declared
 *   MIME type and validate against ALLOWED_TEXT_MIME_TYPES allowlist
 *
 * This prevents:
 * - Executable files from being uploaded
 * - MIME type spoofing for binary files (checks magic bytes)
 * - Unknown text types that could be dangerous
 *
 * Accepts either a Multer file or a generic `{ buffer?, path?, mimetype }`
 * shape so presigned (streaming) uploads can reuse the same validation.
 */
export const validateMimeType = async (file: MimeSource) => {
  if (!file.buffer && !file.path) {
    throw new Error("validateMimeType requires either a buffer or a file path");
  }
  // The stored content type is a VARCHAR(255).
  if (file.mimetype.length > 255) {
    throw new BadRequestError(
      "invalid_content_type",
      "Content type must be 255 characters or fewer"
    );
  }
  const detectedType = file.buffer
    ? await fileTypeFromBuffer(file.buffer)
    : await fileTypeFromFile(file.path!);
  if (detectedType) {
    // Binary file type detected - validate against blocklist
    if (BLOCKED_EXTENSIONS.has(detectedType.ext)) {
      throw new BadRequestError(
        "blocked_file_type",
        `File type ${detectedType.ext} (${detectedType.mime}) is not allowed for security reasons`
      );
    }
    if (BLOCKED_MIME_TYPES.has(detectedType.mime)) {
      throw new BadRequestError(
        "blocked_file_type",
        `File type ${detectedType.mime} is not allowed for security reasons`
      );
    }
  } else {
    // file-type couldn't detect (likely text-based file)
    // Fall back to multer's MIME type detection
    const uploadedMimeType = file.mimetype.toLowerCase();

    // Block dangerous MIME types
    if (BLOCKED_MIME_TYPES.has(uploadedMimeType)) {
      throw new BadRequestError(
        "blocked_file_type",
        `File type ${uploadedMimeType} is not allowed for security reasons`
      );
    }

    // For undetectable files, accept known-safe text MIME types outright, and
    // fall back to a content sniff for anything else (including the generic
    // application/octet-stream browsers send for unknown extensions like .conf
    // or .ini). NUL-free content is treated as text.
    if (ALLOWED_TEXT_MIME_TYPES.has(uploadedMimeType)) return;
    if (await looksLikeText(file)) return;
    throw new BadRequestError(
      "unrecognized_text_file_type",
      `File type ${uploadedMimeType} is not recognized as a safe text-based format. ` +
        `Allowed text types: ${Array.from(ALLOWED_TEXT_MIME_TYPES).join(", ")}`
    );
  }
};

// Content types safe to render inline in the browser. Anything not listed —
// notably text/html, application/xhtml+xml, image/svg+xml, and XML — is served
// as an attachment so that content uploaded by one user (uploads of text/html
// and text/javascript are permitted, see ALLOWED_TEXT_MIME_TYPES) can never
// execute script in the file-service origin when another user opens its URL
// (stored XSS). `X-Content-Type-Options: nosniff` is always set alongside this
// so the browser cannot override the declared Content-Type by sniffing.
const INLINE_SAFE_PREFIXES = ["image/", "video/", "audio/"];
const INLINE_SAFE_EXACT = new Set(["application/pdf", "text/plain"]);
// image/svg+xml matches the image/ prefix but can carry inline script — it must
// never be served inline.
const INLINE_UNSAFE_EXACT = new Set(["image/svg+xml"]);

export const isInlineSafeContentType = (contentType: string): boolean => {
  // Parsed strictly, so a stored `image/png, text/html` (which a browser
  // renders as HTML) is never inline.
  const normalized = normalizeContentType(contentType);
  if (!normalized) return false;
  const ct = normalized.split(";")[0];
  if (INLINE_UNSAFE_EXACT.has(ct)) return false;
  if (INLINE_SAFE_EXACT.has(ct)) return true;
  return INLINE_SAFE_PREFIXES.some((p) => ct.startsWith(p));
};

// Control characters, double quote and backslash never belong in a filename;
// lone surrogates would make encodeURIComponent throw.
const sanitizeFilename = (name: string): string =>
  name
    // eslint-disable-next-line no-control-regex -- header-injection guard
    .replace(/[\x00-\x1f\x7f"\\]/g, "_")
    .replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      "_"
    );

/** RFC 5987 `value-chars`: encodeURIComponent leaves `'()*` unescaped. */
const encodeRfc5987 = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

/**
 * A `Content-Disposition` value. Header values must be Latin-1 (Node throws
 * otherwise), so `filename=` carries an ASCII fallback with everything outside
 * printable ASCII replaced by `_`, and `filename*=` the real name, encoded.
 */
export const contentDisposition = (
  type: "inline" | "attachment",
  name: string
): string => {
  const filename = sanitizeFilename(name);
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_");
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
};

/**
 * Set `Content-Disposition` on a download response with a safe default: inline
 * only for known-safe content types, attachment for everything else. Callers
 * can force attachment (e.g. share links). The filename is sanitized against
 * header injection and emitted as an ASCII `filename=` and an RFC 5987
 * `filename*=` (`contentDisposition`).
 *
 * Every download path calls this, so it also sets the sandboxing CSP: should
 * a browser render user content on core's origin anyway, it runs no script
 * and loads nothing.
 */
export const setContentDisposition = (
  res: Response,
  opts: {
    contentType: string;
    objectKey: string;
    filenameOverride?: string | null;
    forceAttachment?: boolean;
  }
) => {
  const inline =
    !opts.forceAttachment && isInlineSafeContentType(opts.contentType);
  const filename =
    opts.filenameOverride ?? opts.objectKey.split("/").pop() ?? "download";
  res.setHeader(
    "Content-Disposition",
    contentDisposition(inline ? "inline" : "attachment", filename)
  );
  res.setHeader(
    "Content-Security-Policy",
    downloadCsp(opts.contentType, inline)
  );
};

// Browsers' built-in PDF viewers don't run inside a sandboxed frame, so an
// inline PDF keeps only `default-src 'none'`; the rest stays sandboxed.
export const downloadCsp = (contentType: string, inline: boolean): string =>
  inline &&
  normalizeContentType(contentType)?.split(";")[0] === "application/pdf"
    ? "default-src 'none'"
    : "sandbox; default-src 'none'";

export const handleMetadata = (req: Request) => {
  const metadataHeader = req.headers["x-metadata"] as string | undefined;
  if (!metadataHeader) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let metadata: Record<string, any> | undefined;
  if (Buffer.byteLength(metadataHeader, "utf8") > MAX_METADATA_HEADER_SIZE) {
    throw new BadRequestError(
      "x_metadata_header_too_large",
      `X-Metadata header exceeds maximum size of ${MAX_METADATA_HEADER_SIZE} bytes`
    );
  }

  try {
    metadata = JSON.parse(metadataHeader);
  } catch {
    throw new BadRequestError("invalid_metadata", "Invalid metadata JSON");
  }

  const validationResult = metadataSchema.safeParse(metadata);
  if (!validationResult.success) {
    throw new BadRequestError(
      "invalid_metadata",
      `Invalid metadata: ${validationResult.error.issues[0].message}`
    );
  }

  return metadata;
};

export const getBucket = async (name: string, auth: AuthContext) => {
  const bucket = await getAccessibleBucket(auth, name, "write");
  return bucket;
};

/**
 * Keys the objects router answers with its own routes, so an object stored
 * under one could not be read back by key: `GET /objects/prefixes` is the
 * prefix listing, and `/objects/by-id/…` and `/objects/by-key/…` are the
 * id- and key-addressed routes. `.thumbnails/…` is where generated thumbnails
 * live. Refused on every write that names a key.
 */
export const assertObjectKeyNotReserved = (key: string) => {
  // Express matches route paths case-insensitively, so `Prefixes` and
  // `BY-ID/…` reach those routes too.
  const routed = key.toLowerCase();
  if (
    routed === "prefixes" ||
    routed.startsWith("by-id/") ||
    routed.startsWith("by-key/") ||
    key.startsWith(".thumbnails/")
  ) {
    throw new BadRequestError(
      "reserved_object_key",
      `Object key "${key}" is reserved: "prefixes" and keys starting with "by-id/" or "by-key/" are routes, and ".thumbnails/" holds generated thumbnails`
    );
  }
};

export const standardizeObjectKey = (req: Request) => {
  // Extract the object key from wildcard parameter
  if (Array.isArray(req.params.objectKey)) {
    req.params.objectKey = req.params.objectKey.join("/");
  } else if (req.params[0]) req.params.objectKey = req.params[0];
};

export interface EtagPreconditions {
  ifMatch: string[] | null;
  ifNoneMatch: string[] | null;
  ifNoneMatchWildcard: boolean;
}

/**
 * Parse If-Match / If-None-Match headers. Per RFC 7232, values are a
 * comma-separated list of ETags or `*`. We strip surrounding quotes and `W/`
 * weak-validator prefixes for comparison.
 */
export const parseEtagPreconditions = (req: Request): EtagPreconditions => {
  const parseList = (header: string | undefined): string[] | null => {
    if (!header) return null;
    return header
      .split(",")
      .map((s) => s.trim())
      .map((s) => (s.startsWith("W/") ? s.slice(2) : s))
      .map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s))
      .filter((s) => s.length > 0);
  };
  const ifMatchRaw = req.headers["if-match"] as string | undefined;
  const ifNoneMatchRaw = req.headers["if-none-match"] as string | undefined;
  return {
    ifMatch: parseList(ifMatchRaw),
    ifNoneMatch: parseList(ifNoneMatchRaw),
    ifNoneMatchWildcard: ifNoneMatchRaw?.trim() === "*",
  };
};

const parseJsonTags = (raw: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((t): t is string => typeof t === "string" && t.length > 0)
  ) {
    throw new BadRequestError(
      "invalid_request",
      'X-Tags starting with "[" must be a JSON array of non-empty strings'
    );
  }
  return parsed;
};

/**
 * `X-Tags` comes in two forms. A value starting with `[` is a JSON array of
 * strings — with non-ASCII characters `\u`-escaped, since a header value
 * cannot carry them — taken as is, like `tags` in a JSON body. Any other value
 * is comma-separated, each tag trimmed and empty ones dropped. A value
 * starting with `[` is never read as the comma form.
 */
export const extractTagsFromRequest = (req: Request): string[] | undefined => {
  const raw = req.headers["x-tags"] as string | undefined;
  if (!raw) return undefined;
  if (Buffer.byteLength(raw, "utf8") > 10 * 1024) {
    throw new BadRequestError(
      "x_tags_header_too_large",
      "X-Tags header too large"
    );
  }
  const tags = raw.trimStart().startsWith("[")
    ? parseJsonTags(raw)
    : raw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
  if (tags.length > 50) {
    throw new BadRequestError("too_many_tags", "Maximum 50 tags per object");
  }
  for (const tag of tags) {
    if (tag.length > 128) {
      throw new BadRequestError(
        "tag_too_long",
        "Tag length exceeds 128 characters"
      );
    }
  }
  return tags;
};

/**
 * Remove the Multer-staged temp file. Safe to call repeatedly — ignores ENOENT.
 */
export const cleanupMulterTempFile = async (
  file: Express.Multer.File | undefined
) => {
  if (!file?.path) return;
  await fs.unlink(file.path).catch(() => {});
};

/**
 * Shared API serializer for an Object. Reads content fields from the joined
 * current ObjectVersion + ContentBlob (which the DB helpers eagerly include).
 */
export const serializeObject = (obj: ObjectWithCurrent) => {
  const current = obj.versions[0];
  if (!current || !current.contentBlob) {
    throw new NotFoundError("Object has no current content");
  }
  return {
    id: obj.id,
    key: obj.objectKey,
    contentType: current.contentType ?? "application/octet-stream",
    sizeBytes: current.contentBlob.sizeBytes.toString(),
    etag: current.etag ?? "",
    metadata: current.metadata,
    tags: current.tags,
    deleteAfter: obj.deleteAfter ? obj.deleteAfter.toISOString() : null,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
};

/**
 * A deleted object, as `GET /objects?deleted=true` lists it: no content
 * fields, since its current version is a delete marker. Its versions are at
 * `by-id/:id/versions`, where restoring one undeletes it. `deletedByUser`
 * is null for a caller who is not a reader of the bucket, as version
 * writers are.
 */
export const serializeDeletedObject = (obj: {
  id: string;
  objectKey: string;
  deletedAt: Date | null;
  deletedBy: string | null;
  deletedByUser: UserRef | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: obj.id,
  key: obj.objectKey,
  deletedAt: obj.deletedAt,
  deletedBy: obj.deletedBy,
  deletedByUser: obj.deletedByUser,
  createdAt: obj.createdAt,
  updatedAt: obj.updatedAt,
});

/**
 * Only a public bucket's bytes may be kept by a shared cache. A key's current
 * content changes with the next upload, so it is revalidated by ETag on every
 * use; a pinned version never changes.
 */
export const downloadCacheControl = (
  bucket: { policy: string },
  pinnedVersion: boolean
) =>
  `${bucket.policy === "public" ? "public" : "private"}, ${
    pinnedVersion ? "max-age=31536000, immutable" : "no-cache"
  }`;

/**
 * Send a blob's plaintext as the body of a download whose other headers are
 * set: the whole of it, or one byte range (`Range`, honoured unless
 * `If-Range` says the client's copy is stale) as `206 Partial Content`. An
 * unsatisfiable range is `416`, its `Content-Range` giving the size; several
 * ranges get the whole body.
 *
 * Blobs up to `INTEGRITY_VERIFY_MAX_BYTES` are decrypted and verified in full
 * before a byte is sent, then sliced. Larger ones stream; a range of one is
 * decrypted from its offset and not covered by the GCM tag.
 */
export const sendBlobBody = async (
  req: Request,
  res: Response,
  blob: {
    hash: string;
    fsPath: string;
    sizeBytes: bigint;
    wrappedDek: Uint8Array;
    iv: Uint8Array;
    masterKeyVersion: number;
  },
  validators: { etag: string; lastModified?: Date }
) => {
  const size = Number(blob.sizeBytes);
  res.setHeader("Accept-Ranges", "bytes");
  const requested = ifRangeAllows(
    req.header("If-Range"),
    validators.etag,
    validators.lastModified
  )
    ? parseRange(req.header("Range"), size)
    : null;
  if (requested === "unsatisfiable") {
    res.setHeader("Content-Range", `bytes */${size}`);
    res.removeHeader("Content-Disposition");
    throw new AppError(
      416,
      "range_not_satisfiable",
      "The requested range is outside the content"
    );
  }
  if (requested) {
    res.status(206);
    res.setHeader(
      "Content-Range",
      `bytes ${requested.start}-${requested.end}/${size}`
    );
    res.setHeader(
      "Content-Length",
      String(requested.end - requested.start + 1)
    );
  } else {
    res.setHeader("Content-Length", String(size));
  }

  const meta = {
    fsPath: blob.fsPath,
    keyMaterial: {
      wrappedDek: Buffer.from(blob.wrappedDek),
      iv: Buffer.from(blob.iv),
      masterKeyVersion: blob.masterKeyVersion,
    },
  };

  // Throws before anything is sent, so tampered storage is a clean 500.
  const buffered = await loadVerifiedBlobIfSmall(meta, blob.hash, size);
  if (buffered) {
    res.end(
      requested
        ? buffered.subarray(requested.start, requested.end + 1)
        : buffered
    );
    return;
  }

  const stream = requested
    ? await openBlobRangeStream(meta, blob.hash, requested.start, requested.end)
    : openBlobStream(meta, blob.hash);
  stream.on("error", (err) => {
    if (res.headersSent) {
      // Headers are out (e.g. GCM verification failed at the end): reset the
      // connection so the client sees a truncated response, not a whole one.
      res.destroy(err);
      return;
    }
    sendError(res, new AppError(500, "server_error", "Failed to read file"));
  });
  // `.pipe` only unpipes when the client goes away; this closes the file.
  res.on("close", () => stream.destroy());
  stream.pipe(res);
};

/**
 * After an object write commits: queue the blobs it released (the prior
 * content's and its dropped thumbnails') for cleanup and, in a bucket with
 * `autoThumbnails`, thumbnails for image content. Both are fire-and-forget,
 * off the request path.
 */
export const queueObjectWriteFollowUps = (
  bucket: { name: string; autoThumbnails: boolean },
  objectId: string,
  contentType: string,
  releasedBlobHashes: string[]
) => {
  for (const hash of new Set(releasedBlobHashes)) {
    enqueueOrphanBlobCleanupSafe(hash);
  }
  if (bucket.autoThumbnails && isThumbnailSource(contentType)) {
    enqueueThumbnailGeneration(objectId).catch((err) => {
      logger.warn(
        { parentObjectId: objectId, bucketName: bucket.name, err },
        "Thumbnail enqueue failed"
      );
    });
  }
};
