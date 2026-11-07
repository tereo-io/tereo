import { BRANDING_BUCKET, BRANDING_IMAGE_GRACE_MS } from "./storage.js";
import { BadRequestError } from "../errors.js";
import type { Prisma } from "../db/prisma.js";
import db from "../db/index.js";

/**
 * Lock the live objects a profile is about to reference and clear their
 * expiry. The lock orders this against the sweep, so a profile never points
 * at an object the sweep removed.
 */
export const referenceImagesTx = async (
  tx: Prisma.TransactionClient,
  objectIds: string[]
): Promise<void> => {
  const ids = [...new Set(objectIds)];
  if (ids.length === 0) return;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT o."id" FROM "files"."objects" o
    JOIN "files"."buckets" b ON b."id" = o."bucket_id"
    WHERE o."id" = ANY(${ids}::uuid[])
      AND b."name" = ${BRANDING_BUCKET}
      AND o."deleted_at" IS NULL
    ORDER BY o."id"
    FOR UPDATE OF o
  `;
  if (rows.length !== ids.length) {
    throw new BadRequestError(
      "unknown_branding_image",
      "A referenced branding image does not exist"
    );
  }
  await tx.$executeRaw`
    UPDATE "files"."objects" SET "delete_after" = NULL
    WHERE "id" = ANY(${ids}::uuid[])
  `;
};

/**
 * Start the expiry clock on images a profile no longer references, unless
 * another profile still does. Call after the profile write, in its transaction.
 */
export const releaseImagesTx = async (
  tx: Prisma.TransactionClient,
  objectIds: string[],
  now: Date
): Promise<void> => {
  const referenced = await db.brandingProfiles.referencedObjectIds(tx);
  const dropped = [...new Set(objectIds)].filter((id) => !referenced.has(id));
  if (dropped.length === 0) return;
  await tx.$executeRaw`
    UPDATE "files"."objects"
    SET "delete_after" = ${new Date(now.getTime() + BRANDING_IMAGE_GRACE_MS)}
    WHERE "id" = ANY(${dropped}::uuid[]) AND "deleted_at" IS NULL
  `;
};
