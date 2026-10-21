import { shareUnlockBackoff } from "../../../../../middleware/rateLimit.js";
import { storeShareUrlNonce } from "../../../../../utils/shareUrlNonces.js";
import { contentDisposition } from "../../buckets/bucket/objects/utils.js";
import { sign as presignSign } from "../../../../../utils/presigning.js";
import { setAccessLog } from "../../../../../middleware/accessLog.js";
import { SYSTEM_USER_ID } from "../../../../../definitions/index.js";
import { logAuditTx, emitTx } from "../../../../../utils/outbox.js";
import { ipRateLimitKey } from "../../../../../utils/rateLimit.js";
import { tokenParamSchema, unlockBodySchema } from "./schemas.js";
import { verifyPassword } from "../../../../../utils/password.js";
import type { Prisma } from "../../../../../utils/db/prisma.js";
import { clientIp } from "../../../../../utils/requestId.js";
import db from "../../../../../utils/db/index.js";
import { Request, Response } from "express";
import env from "../../../../../env.js";
import {
  recordUnlockAttempt,
  resetUnlockAttempts,
} from "../../../../../utils/shareUnlockLimiter.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from "../../../../../utils/errors.js";

interface LoadedShare {
  id: string;
  token: string;
  bucketId: number;
  bucketName: string;
  organizationId: string | null;
  kind: "OBJECT" | "ARCHIVE";
  objectId: string | null;
  objectKey: string | null;
  versionId: string | null;
  archiveRequestId: string | null;
  archiveFilename: string | null;
  archiveFormat: string | null;
  urlFilename: string | null;
  passwordHash: string | null;
  expiresAt: Date | null;
  maxDownloads: number | null;
  downloadCount: number;
  revokedAt: Date | null;
}

async function loadShareForDownload(
  token: string
): Promise<LoadedShare | null> {
  const share = await db.shares.getByTokenRaw(token);
  if (!share) return null;
  if (share.revokedAt || !share.creator.isActive) return null;
  if (share.expiresAt && share.expiresAt.getTime() < Date.now()) return null;
  if (
    share.maxDownloads !== null &&
    share.downloadCount >= share.maxDownloads
  ) {
    return null;
  }

  // db.buckets.get throws NotFoundError when the bucket is soft-deleted or
  // missing; we translate to "not found" to keep the public endpoint from
  // leaking state.
  let bucket;
  try {
    bucket = await db.buckets.get(share.bucketId);
  } catch {
    return null;
  }

  // Kind-aware target resolution. Rejecting soft-deleted objects / pinned
  // versions here is what stops a tombstoned target from consuming the
  // share's download cap and then 404-ing late at the signed-URL layer.
  let objectKey: string | null = null;
  let archiveFilename: string | null = null;
  let archiveFormat: string | null = null;
  if (share.kind === "OBJECT") {
    if (!share.objectId) return null;
    const target = await db.shares.getLiveObjectTarget(
      share.objectId,
      share.versionId
    );
    if (!target) return null;
    objectKey = target.objectKey;
  } else {
    if (!share.archiveRequestId) return null;
    const archive = await db.shares.getLiveArchiveTarget(
      share.archiveRequestId
    );
    if (!archive) return null;
    archiveFilename = archive.filename;
    archiveFormat = archive.format;
  }

  return {
    id: share.id,
    token: share.token,
    bucketId: share.bucketId,
    bucketName: bucket.name,
    organizationId: bucket.organizationId,
    kind: share.kind,
    objectId: share.objectId,
    objectKey,
    versionId: share.versionId,
    archiveRequestId: share.archiveRequestId,
    archiveFilename,
    archiveFormat,
    urlFilename: share.urlFilename,
    passwordHash: share.passwordHash,
    expiresAt: share.expiresAt,
    maxDownloads: share.maxDownloads,
    downloadCount: share.downloadCount,
    revokedAt: share.revokedAt,
  };
}

/**
 * Without `disposition=attachment` browsers inline images / PDFs / videos,
 * the wrong default for share links. It is unsigned: it can only force
 * attachment, never weaken it.
 */
function withAttachmentHint(url: string): string {
  const u = new URL(url);
  u.searchParams.set("disposition", "attachment");
  return u.toString();
}

function shareDownloadFilename(share: LoadedShare): string | null {
  if (share.urlFilename) return share.urlFilename;
  if (share.kind === "OBJECT" && share.objectKey) {
    const basename = share.objectKey.split("/").pop();
    return basename && basename.length > 0 ? basename : share.objectKey;
  }
  if (share.kind === "ARCHIVE") return share.archiveFilename;
  return null;
}

/**
 * A capped share's URL is single-use: its nonce is stored here and spent by
 * the first GET the signed route serves (`utils/shareUrlNonces.ts`).
 */
async function mintSignedUrlFor(
  share: LoadedShare
): Promise<{ url: string; expiresAt: Date }> {
  const signed = signFor(share);
  if (share.maxDownloads !== null) {
    await storeShareUrlNonce(share.id, signed.nonce, signed.expiresAt);
  }
  return { url: signed.url, expiresAt: signed.expiresAt };
}

function signFor(share: LoadedShare): {
  url: string;
  expiresAt: Date;
  nonce: string;
} {
  // Clamp the signed-URL TTL to the share's own expiry so a URL minted on
  // the last second of a share's life can't outlive the share by up to the
  // configured signed-URL window. `Math.max(1, ...)` keeps the minimum a
  // valid (non-zero) TTL — `presignSign` rejects <= 0.
  const baseTtl = env.FILE_SERVICE_SHARE_SIGNED_URL_TTL_SECONDS;
  const ttl = share.expiresAt
    ? Math.max(
        1,
        Math.min(
          baseTtl,
          Math.floor((share.expiresAt.getTime() - Date.now()) / 1000)
        )
      )
    : baseTtl;
  if (share.kind === "OBJECT" && share.objectId) {
    const signed = presignSign({
      bucket: share.bucketName,
      id: share.objectId,
      operation: "read",
      expiresInSeconds: ttl,
      // Bind the share id into the HMAC so the signed-download handler can
      // look up the share row and refuse to serve a revoked / expired /
      // exhausted share. Closes the revocation-latency window where a
      // pre-minted URL would otherwise stay live for the full TTL.
      share: share.id,
      version: share.versionId ?? undefined,
      // Without one, the download is named after the object's key anyway.
      filename: share.urlFilename ?? undefined,
    });
    return {
      url: withAttachmentHint(signed.url),
      expiresAt: signed.expiresAt,
      nonce: signed.nonce,
    };
  }
  if (share.kind === "ARCHIVE" && share.archiveRequestId) {
    // Archive downloads always set Content-Disposition: attachment.
    const signed = presignSign({
      bucket: share.bucketName,
      id: share.archiveRequestId,
      operation: "archive",
      expiresInSeconds: ttl,
      share: share.id,
    });
    return signed;
  }
  // Should be unreachable — the CHECK constraint prevents this state. Treat
  // as not-found to avoid leaking the invariant violation to the caller.
  throw new NotFoundError("Share not found");
}

async function logShareAccessTx(
  tx: Prisma.TransactionClient,
  share: LoadedShare,
  req: Request,
  unlocked: boolean
): Promise<void> {
  await logAuditTx(tx, {
    auth: { userId: SYSTEM_USER_ID, email: null },
    organizationId: share.organizationId ?? undefined,
    action: "CREATE",
    entityType: "shareAccess",
    entityId: share.id,
    metadata: {
      bucketName: share.bucketName,
      kind: share.kind,
      objectId: share.objectId,
      archiveRequestId: share.archiveRequestId,
      unlocked,
      userAgent: req.headers["user-agent"] ?? null,
      ipAddress: clientIp(req),
    },
  });

  if (env.FILE_SERVICE_EMIT_SHARE_ACCESS_EVENTS && share.organizationId) {
    await emitTx(tx, {
      eventType: "file-service.share.accessed",
      organizationId: share.organizationId,
      entityType: "share",
      entityId: share.id,
      data: {
        bucketName: share.bucketName,
        kind: share.kind,
        unlocked,
      },
    });
  }
}

/**
 * GET /shared/:token (no auth). Returns either a 302 redirect to a short-
 * lived presigned download URL, a 401 { requiresPassword: true } when a
 * password gate is set, or a uniform 404 for any unserveable state
 * (missing, revoked, expired, exhausted). The uniform 404 prevents the
 * endpoint from becoming an oracle for share validity.
 */
export const getShareViaToken = async (req: Request, res: Response) => {
  const { token } = validateParams(tokenParamSchema, req);

  const share = await loadShareForDownload(token);
  if (!share) {
    throw new NotFoundError("Share not found");
  }

  if (share.passwordHash) {
    // Content-negotiate: browsers get bounced to the admin UI's `/shared/:token`
    // route which renders a proper password form; programmatic clients (curl,
    // scripts, the UI's own Accept: application/json fetch) get the JSON 401
    // and can call /unlock directly.
    const uiBase = env.FILE_SERVICE_SHARE_UI_BASE_URL;
    if (req.accepts(["json", "html"]) === "html") {
      const tokenSafe = encodeURIComponent(token);
      // Forward the cosmetic filename suffix so /shared/<token>/report.pdf
      // stays pretty across the redirect; the UI ignores the segment but it
      // keeps the URL in the address bar consistent with what was shared.
      const filenameParam = req.params.filename;
      const filenameSuffix =
        typeof filenameParam === "string" && filenameParam.length > 0
          ? `/${encodeURIComponent(filenameParam)}`
          : "";
      res.redirect(
        302,
        `${uiBase.replace(/\/+$/, "")}/shared/${tokenSafe}${filenameSuffix}`
      );
      return;
    }
    throw new UnauthorizedError(
      "This share is password-protected. POST the password to /shared/:token/unlock to receive a download URL.",
      "password_required",
      { details: { requiresPassword: true } }
    );
  }

  // Minted before the download is counted: a capped share's URL needs Redis,
  // and when Redis is down the 503 shouldn't spend one of its downloads.
  const signed = await mintSignedUrlFor(share);
  const incremented = await db.$transaction(async (tx) => {
    const inc = await db.shares.atomicIncrementDownloads(share.id, tx);
    if (!inc) return null;
    await logShareAccessTx(tx, share, req, false);
    return inc;
  });
  if (!incremented) {
    // Raced with another caller and lost; treat as exhausted.
    throw new NotFoundError("Share not found");
  }

  setAccessLog(res, {
    bucketId: share.bucketId,
    objectId: share.objectId ?? undefined,
    operation: "DOWNLOAD_SHARE",
  });

  res.redirect(302, signed.url);
};

const PROBE_HEADERS = [
  "X-Share-Kind",
  "X-Share-Size-Bytes",
  "X-Share-Downloads-Remaining",
  "X-Share-Expires-At",
] as const;

/**
 * HEAD /shared/:token (no auth). A status probe that never counts a download
 * or mints a URL, so link unfurlers and the UI's share page can look before
 * fetching. Without this route Express would answer HEAD with the GET
 * handler, which consumes a download.
 *
 * It reveals no more than GET: the same uniform 404 for any unserveable
 * state, a bare 401 for a password share (no file details until unlocked),
 * and for an open share — whose GET hands over the file itself — the file's
 * name, type and size plus the share's remaining downloads and expiry.
 */
export const probeShareViaToken = async (req: Request, res: Response) => {
  const { token } = validateParams(tokenParamSchema, req);

  const share = await loadShareForDownload(token);
  if (!share) {
    throw new NotFoundError("Share not found");
  }

  res.setHeader("Cache-Control", "private, no-store");
  if (share.passwordHash) {
    throw new UnauthorizedError(
      "This share is password-protected.",
      "password_required"
    );
  }

  res.setHeader(
    "Access-Control-Expose-Headers",
    ["Content-Disposition", ...PROBE_HEADERS].join(", ")
  );
  res.setHeader("X-Share-Kind", share.kind);

  if (share.kind === "OBJECT" && share.objectId) {
    const details = await db.shares.getObjectTargetDetails(
      share.objectId,
      share.versionId
    );
    res.setHeader(
      "Content-Type",
      details.contentType ?? "application/octet-stream"
    );
    if (details.sizeBytes !== null) {
      res.setHeader("X-Share-Size-Bytes", details.sizeBytes.toString());
    }
  } else {
    res.setHeader(
      "Content-Type",
      share.archiveFormat === "tar" ? "application/x-tar" : "application/zip"
    );
  }

  const filename = shareDownloadFilename(share);
  if (filename) {
    res.setHeader(
      "Content-Disposition",
      contentDisposition("attachment", filename)
    );
  }
  if (share.maxDownloads !== null) {
    res.setHeader(
      "X-Share-Downloads-Remaining",
      String(Math.max(0, share.maxDownloads - share.downloadCount))
    );
  }
  if (share.expiresAt) {
    res.setHeader("X-Share-Expires-At", share.expiresAt.toISOString());
  }
  res.status(200).end();
};

/**
 * The password half of an unlock, behind `shareUnlockBackoff` (see
 * `unlockShare`). Returns on a correct password; throws 401 or 429 otherwise.
 */
const checkSharePassword = async (
  req: Request,
  token: string,
  passwordHash: string,
  password: string,
  { firstFromAddress }: { firstFromAddress: boolean }
): Promise<void> => {
  try {
    // Spent before the password is checked, atomically, so concurrent wrong
    // attempts cannot outrun the count; a correct password resets it.
    await shareUnlockBackoff.check(req, token);
  } catch (err) {
    if (!(err instanceof TooManyRequestsError) || !firstFromAddress) throw err;
    // Spent although the delay is running, so a wrong guess still lengthens
    // it; a right one resets it.
    await shareUnlockBackoff.spendUnblocked(req, token);
    if (await verifyPassword(passwordHash, password)) return;
    throw err;
  }
  if (!(await verifyPassword(passwordHash, password))) {
    throw new UnauthorizedError("Incorrect password.", "invalid_password");
  }
};

/**
 * POST /shared/:token/unlock (no auth).
 *
 * Rate-limited per (token, ip), and a password share also backs off per
 * token (`shareUnlockBackoff`) whatever the address. Verifies the password
 * and, on success, mints a short-lived presigned URL and returns it as JSON.
 * The browser navigates to that URL to perform the actual download.
 *
 * The backoff is keyed on the token alone, so anyone with the link can start
 * it. So that this does not lock the recipients out, an address's first
 * attempt in its per-(token, ip) window is still verified during a delay: a
 * correct password unlocks (and resets the backoff); a wrong one gets the
 * same 429 as any other attempt during the delay, and lengthens it. Any
 * further attempt from that address waits out the delay unverified, so a
 * guesser needs a fresh address for every guess while the delay lasts.
 */
export const unlockShare = async (req: Request, res: Response) => {
  const { token } = validateParams(tokenParamSchema, req);
  const body = validateBody(unlockBodySchema, req);
  // The limiter's key: by the address's /64 for IPv6, as the other limiters
  // key it, since one host holds a whole /64 and could rotate through it.
  const ip = ipRateLimitKey(clientIp(req));

  // Verify the share exists BEFORE consuming the rate-limit budget. Otherwise
  // an attacker behind a shared NAT can spam invalid tokens at this endpoint
  // and lock out legitimate users on the same IP from unlocking real shares.
  const share = await loadShareForDownload(token);
  if (!share) {
    throw new NotFoundError("Share not found");
  }
  const password = body?.password ?? "";
  if (share.passwordHash && !password) {
    throw new ValidationError("Invalid request body. password: Required");
  }

  const attempt = await recordUnlockAttempt(token, ip);
  if (!attempt.allowed) {
    throw new TooManyRequestsError(
      attempt.retryAfterSeconds,
      "Too many unlock attempts. Try again after the cooldown period."
    );
  }

  // A share without a password falls through to the success path, so
  // clients that POST speculatively still get a URL back.
  if (share.passwordHash) {
    await checkSharePassword(req, token, share.passwordHash, password, {
      firstFromAddress: attempt.first,
    });
  }

  const signed = await mintSignedUrlFor(share);
  const incremented = await db.$transaction(async (tx) => {
    const inc = await db.shares.atomicIncrementDownloads(share.id, tx);
    if (!inc) return null;
    await logShareAccessTx(tx, share, req, true);
    return inc;
  });
  if (!incremented) {
    throw new NotFoundError("Share not found");
  }

  await resetUnlockAttempts(token, ip);
  if (share.passwordHash) await shareUnlockBackoff.reset(req, token);

  setAccessLog(res, {
    bucketId: share.bucketId,
    objectId: share.objectId ?? undefined,
    operation: "UNLOCK_SHARE",
  });

  res.json({
    url: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
  });
};
