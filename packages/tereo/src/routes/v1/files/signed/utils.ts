import { signedObjectParamsSchema, signedQuerySchema } from "./schemas.js";
import { validateQuery } from "../../../../utils/validateReq.js";
import { ForbiddenError } from "../../../../utils/errors.js";
import type { Prisma } from "../../../../utils/db/prisma.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { pipeline as pipelineCb } from "stream";
import db from "../../../../utils/db/index.js";
import { Request, Response } from "express";
import { promisify } from "util";
import {
  consumeShareUrlNonce,
  restoreShareUrlNonce,
} from "../../../../utils/shareUrlNonces.js";
import {
  canReadBucket,
  canWriteBucket,
} from "../../../../utils/bucketAccess.js";
import {
  verify as presignVerify,
  type PresignOperation,
  type VerifiedPresign,
} from "../../../../utils/presigning.js";

// Magic bytes needed by the `file-type` library fit in well under 64 bytes,
// but we buffer more to accommodate rare long signatures (e.g. FLAC, CRW).
export const MIME_SNIFF_BYTES = 4 * 1024;

export const pipeline = promisify(pipelineCb);

/** The bucket and object id of an object URL; malformed is a wrong signature. */
export function signedObjectParams(req: Request): {
  bucket: string;
  id: string;
} {
  const parsed = signedObjectParamsSchema.safeParse(req.params);
  if (!parsed.success) throw new ForbiddenError("Invalid signature");
  return parsed.data;
}

/** Checks the URL's signature over `bucket`, `id` and `operation`. */
export function verifySignedQuery(
  req: Request,
  target: { bucket: string; id: string; operation: PresignOperation }
): VerifiedPresign {
  const query = validateQuery(signedQuerySchema, req);
  const verified = presignVerify({ ...target, ...query });
  if (verified.operation !== target.operation) {
    throw new ForbiddenError("Signature operation mismatch");
  }
  return verified;
}

/** `?disposition=attachment` only ever strengthens the default disposition. */
export const forcesAttachment = (req: Request): boolean =>
  validateQuery(signedQuerySchema, req).disposition === "attachment";

/**
 * For a URL minted from a share: refuses it once the share no longer serves
 * (revoked, expired, exhausted, or its creator deactivated). Spends nothing:
 * a capped share's nonce is spent by `spendShareUrl`, once the response is
 * about to be written.
 */
export async function assertShareServeable(
  verified: Pick<VerifiedPresign, "share">
): Promise<{ capped: boolean } | null> {
  if (!verified.share) return null;
  const share = await db.shares.getServeableShare(verified.share);
  if (!share) {
    throw new ForbiddenError("Share is no longer available");
  }
  return share;
}

/** A capped share's URL serves once: GETDEL, so of two racing hits one wins. */
async function spendShareUrl(
  verified: Pick<VerifiedPresign, "share" | "nonce">,
  share: { capped: boolean } | null
): Promise<boolean> {
  if (!verified.share || !share?.capped) return false;
  await consumeShareUrlNonce(verified.share, verified.nonce);
  return true;
}

/**
 * Writes a download's audit entry and spends a capped share's URL, before
 * any of the body is sent. The nonce is spent last in the transaction, so a
 * URL already used rolls the entry back. Redis can't join the transaction:
 * when the commit fails after the nonce was spent, it is given back
 * (best-effort), so a download that never started doesn't burn the URL.
 * GETDEL decides between concurrent hits whatever happens to the commit, and
 * only the winner can give it back.
 */
export async function auditAndSpendShareUrl(
  verified: Pick<VerifiedPresign, "share" | "nonce" | "expiresAt">,
  share: { capped: boolean } | null,
  audit: (tx: Prisma.TransactionClient) => Promise<void>
): Promise<void> {
  let spent = false;
  try {
    await db.$transaction(async (tx) => {
      await audit(tx);
      spent = await spendShareUrl(verified, share);
    });
  } catch (err) {
    if (spent && verified.share) {
      await restoreShareUrlNonce(
        verified.share,
        verified.nonce,
        verified.expiresAt
      );
    }
    throw err;
  }
}

/**
 * The signer's current standing, as a session in the bucket's organization
 * would have it: their global roles, plus that organization's while they are
 * a member and it is active. For a bucket outside any organization, every
 * active organization they belong to counts, since they could have signed
 * from any of them. Null for an inactive or missing user.
 */
const signerAccessor = async (
  userId: string,
  organizationId: string | null
) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isActive: true },
  });
  if (!user?.isActive) return null;
  if (!organizationId) {
    return {
      userId,
      organizationId: null,
      permissions: await db.roles.getUserPermissions(userId, "memberships"),
    };
  }
  const member = await prisma.organizationMember.findFirst({
    where: {
      userId,
      organizationId,
      organization: { isActive: true, archivedAt: null },
    },
    select: { id: true },
  });
  const scope = member ? organizationId : null;
  return {
    userId,
    organizationId: scope,
    permissions: await db.roles.getUserPermissions(userId, scope),
  };
};

/**
 * A URL acts with its signer's access, re-checked on every use: once the
 * signer is deactivated or loses the grant or permission, it stops working.
 */
export async function assertSignerMayAccess(
  signerId: string,
  bucket: { name: string; organizationId: string | null },
  operation: "read" | "write"
): Promise<void> {
  const accessor = await signerAccessor(signerId, bucket.organizationId);
  const allowed =
    !!accessor &&
    (operation === "read"
      ? await canReadBucket(accessor, bucket.name)
      : await canWriteBucket(accessor, bucket.name));
  if (!allowed) {
    throw new ForbiddenError("The URL's signer no longer has access");
  }
}

export const verifiedSignedUrl = (res: Response) =>
  res.locals.signedUrl as VerifiedPresign;
