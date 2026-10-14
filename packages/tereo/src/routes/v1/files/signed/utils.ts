import { BadRequestError, ForbiddenError } from "../../../../utils/errors.js";
import { consumeShareUrlNonce } from "../../../../utils/shareUrlNonces.js";
import { type VerifiedPresign } from "../../../../utils/presigning.js";
import { pipeline as pipelineCb } from "stream";
import db from "../../../../utils/db/index.js";
import { Request, Response } from "express";
import { promisify } from "util";

// Magic bytes needed by the `file-type` library fit in well under 64 bytes,
// but we buffer more to accommodate rare long signatures (e.g. FLAC, CRW).
export const MIME_SNIFF_BYTES = 4 * 1024;

export const pipeline = promisify(pipelineCb);

export function stringParam(req: Request, key: string): string {
  const value = req.query[key];
  if (typeof value !== "string") {
    throw new BadRequestError("invalid_request", `Missing query param: ${key}`);
  }
  return value;
}

export function extractId(req: Request): string {
  const raw = req.params.id;
  if (typeof raw !== "string") {
    throw new BadRequestError("invalid_request", "Missing object id");
  }
  return raw;
}

export function extractBucketName(req: Request): string {
  const raw = req.params.bucket;
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * Optional `share=<id>` carried in the URL and bound by the HMAC. When the
 * presign was minted from a `Share` row (rather than directly), this lets the
 * download handler re-check the share's revoked/expired/exhausted state on
 * every hit — closing the window where a leaked URL outlives revocation.
 * Direct presigns leave this unset and skip the DB lookup entirely.
 */
export function shareIdParam(req: Request): string | null {
  const raw = req.query.share;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** Optional `by=<user id>`: who minted the URL, bound by the HMAC. */
export function signerParam(req: Request): string | null {
  const raw = req.query.by;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** Optional `version=<version id>`, bound by the HMAC: a pinned version. */
export function versionParam(req: Request): string | null {
  const raw = req.query.version;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * For a URL minted from a share: refuses it once the share no longer serves,
 * and spends its nonce when the share is capped, so the URL serves once.
 */
export async function ensureShareStillServeable(
  verified: Pick<VerifiedPresign, "share" | "nonce">
): Promise<void> {
  if (!verified.share) return;
  const share = await db.shares.getServeableShare(verified.share);
  if (!share) {
    throw new ForbiddenError("Share is no longer available");
  }
  if (share.capped) {
    await consumeShareUrlNonce(verified.share, verified.nonce);
  }
}

export const verifiedSignedUrl = (res: Response) =>
  res.locals.signedUrl as VerifiedPresign;
