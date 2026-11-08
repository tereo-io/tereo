import type { AdminProfileBodySchema, BrandingFields } from "./schema.js";
import { emitTx, logAuditTx, type AuditLogInput } from "../outbox.js";
import { getDefaultOrganizationId } from "../defaultOrganization.js";
import { referenceImagesTx, releaseImagesTx } from "./expiry.js";
import { imageMaxBytes, keyFitsSlot } from "./images.js";
import { getLiveImageByHash } from "./storage.js";
import { invalidateBranding } from "./resolve.js";
import { logger } from "../logger.js";
import db from "../db/index.js";
import type { z } from "zod";
import {
  type BrandingProfile,
  Prisma,
} from "../../../prisma/generated/client/index.js";
import {
  ManagedByProvisioningError,
  NotFoundError,
  ValidationError,
} from "../errors.js";

/** A profile as written: image slots are object ids, resolved before the transaction. */
export type AdminProfileValues = BrandingFields & {
  logo: string | null;
  logoDark: string | null;
  favicon: string | null;
  background: string | null;
};

export type BrandingWriteTarget = {
  client: { id: string; clientId: string } | null;
};

type Actor = AuditLogInput["auth"];
type Tx = Prisma.TransactionClient;

const SLOTS = [
  "appName",
  "headline",
  "subtitle",
  "signInLabel",
  "notice",
  "layout",
  "footerLinks",
  "colorsLight",
  "colorsDark",
  "applyToConsole",
  "logo",
  "logoDark",
  "favicon",
  "background",
] as const;

const IMAGE_SLOTS = ["logo", "logoDark", "favicon", "background"] as const;

export const EMPTY_PROFILE_VALUES: AdminProfileValues = {
  appName: null,
  headline: null,
  subtitle: null,
  signInLabel: null,
  notice: null,
  layout: null,
  footerLinks: null,
  colorsLight: {},
  colorsDark: {},
  applyToConsole: false,
  logo: null,
  logoDark: null,
  favicon: null,
  background: null,
};

export const profileRowValues = (row: BrandingProfile): AdminProfileValues => ({
  appName: row.appName,
  headline: row.headline,
  subtitle: row.subtitle,
  signInLabel: row.signInLabel,
  notice: row.notice,
  layout: row.layout,
  footerLinks: row.footerLinks as BrandingFields["footerLinks"],
  colorsLight: row.colorsLight as Record<string, string>,
  colorsDark: row.colorsDark as Record<string, string>,
  applyToConsole: row.applyToConsole,
  logo: row.logoObjectId,
  logoDark: row.logoDarkObjectId,
  favicon: row.faviconObjectId,
  background: row.backgroundObjectId,
});

export const imageIds = (values: AdminProfileValues | null) =>
  values
    ? IMAGE_SLOTS.map((slot) => values[slot]).filter(
        (id): id is string => id !== null
      )
    : [];

/**
 * Resolve an admin body's image hashes to live objects: 400 naming the slot
 * when one is missing, of a type the slot refuses, or over its size limit.
 */
export const resolveImageRefs = async (
  body: z.output<typeof AdminProfileBodySchema>
): Promise<AdminProfileValues> => {
  const values: AdminProfileValues = {
    ...body,
    logo: null,
    logoDark: null,
    favicon: null,
    background: null,
  };
  for (const slot of IMAGE_SLOTS) {
    const ref = body[slot];
    if (!ref) continue;
    const stored = await getLiveImageByHash(ref.sha256);
    if (!stored) {
      throw new ValidationError("Unknown branding image", [
        { path: slot, message: "No uploaded branding image has this sha256" },
      ]);
    }
    if (!keyFitsSlot(slot, stored.objectKey)) {
      throw new ValidationError("Wrong image type for the slot", [
        { path: slot, message: `This image's type is not allowed for ${slot}` },
      ]);
    }
    if (stored.sizeBytes > imageMaxBytes(slot)) {
      throw new ValidationError("Image too large for the slot", [
        { path: slot, message: `This image exceeds the ${slot} size limit` },
      ]);
    }
    values[slot] = stored.objectId;
  }
  return values;
};

// jsonb does not keep key order, so colours compare with sorted keys.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))
        )
      : v
  );

export const changedSlots = (
  before: AdminProfileValues | null,
  after: AdminProfileValues | null
) =>
  SLOTS.filter(
    (slot) =>
      canonical((before ?? EMPTY_PROFILE_VALUES)[slot]) !==
      canonical((after ?? EMPTY_PROFILE_VALUES)[slot])
  );

/**
 * One statement, in id order, over every image the write touches: the two
 * helpers lock subsets of these rows, and taking them piecemeal could
 * deadlock against a concurrent write locking an overlapping set.
 */
export const lockImagesTx = async (tx: Tx, ids: string[]) => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  await tx.$queryRaw`
    SELECT "id" FROM "files"."objects"
    WHERE "id" = ANY(${unique}::uuid[])
    ORDER BY "id"
    FOR UPDATE
  `;
};

const lockAndRead = async (tx: Tx, target: BrandingWriteTarget) => {
  const clientUuid = target.client?.id ?? null;
  await db.brandingProfiles.lockForWrite({ clientUuid }, tx);
  // A client delete takes this lock first, so one that ran while this write
  // waited is visible now; writing on would violate the foreign key.
  if (clientUuid && !(await db.clients.exists(clientUuid, tx)))
    throw new NotFoundError("Client not found");
  return clientUuid
    ? await db.brandingProfiles.getByClientUuid(clientUuid, tx)
    : await db.brandingProfiles.getDefault(tx);
};

const refuseProvisioned = (existing: BrandingProfile | null) => {
  if (existing?.provisioned) {
    throw new ManagedByProvisioningError(undefined, {
      details: { provisionedFrom: existing.provisionedFrom },
    });
  }
};

const targetName = (target: BrandingWriteTarget) =>
  target.client?.clientId ?? "default";

/**
 * Create or replace a profile whole. `provisionedFrom` is the provisioning
 * document's file name, or null for an admin write, which a provisioned
 * profile refuses. Callers invalidate the branding cache after commit.
 */
export const saveProfileTx = async (
  tx: Tx,
  target: BrandingWriteTarget,
  values: AdminProfileValues,
  actor: Actor,
  provisionedFrom: string | null
): Promise<BrandingProfile> => {
  const existing = await lockAndRead(tx, target);
  if (provisionedFrom === null) refuseProvisioned(existing);

  const before = existing ? profileRowValues(existing) : null;
  const newIds = imageIds(values);
  const newSet = new Set(newIds);
  const dropped = imageIds(before).filter((id) => !newSet.has(id));
  await lockImagesTx(tx, [...newIds, ...dropped]);
  await referenceImagesTx(tx, newIds);

  const row = await db.brandingProfiles.upsert(
    { clientUuid: target.client?.id ?? null },
    {
      appName: values.appName,
      headline: values.headline,
      subtitle: values.subtitle,
      signInLabel: values.signInLabel,
      notice: values.notice,
      layout: values.layout,
      footerLinks: values.footerLinks ?? Prisma.DbNull,
      colorsLight: values.colorsLight,
      colorsDark: values.colorsDark,
      applyToConsole: values.applyToConsole,
      logoObjectId: values.logo,
      logoDarkObjectId: values.logoDark,
      faviconObjectId: values.favicon,
      backgroundObjectId: values.background,
      provisioned: provisionedFrom !== null,
      provisionedFrom,
      updatedBy: actor.userId,
    },
    tx
  );
  await releaseImagesTx(tx, dropped, new Date());

  const after = profileRowValues(row);
  await logAuditTx(tx, {
    auth: actor,
    action: existing ? "UPDATE" : "CREATE",
    entityType: "BrandingProfile",
    entityId: row.id,
    entityName: targetName(target),
    metadata: { before, after },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.branding.updated",
    entityType: "BrandingProfile",
    entityId: row.id,
    data: {
      clientId: targetName(target),
      changedSlots: changedSlots(before, after),
    },
  });
  return row;
};

/** Delete a profile; 404 when there is none. Callers invalidate after commit. */
export const deleteProfileTx = async (
  tx: Tx,
  target: BrandingWriteTarget,
  actor: Actor
): Promise<void> => {
  const existing = await lockAndRead(tx, target);
  if (!existing) throw new NotFoundError("Branding profile not found");
  refuseProvisioned(existing);

  const before = profileRowValues(existing);
  const dropped = imageIds(before);
  await lockImagesTx(tx, dropped);
  await db.brandingProfiles.remove(
    { clientUuid: target.client?.id ?? null },
    tx
  );
  await releaseImagesTx(tx, dropped, new Date());

  await logAuditTx(tx, {
    auth: actor,
    action: "DELETE",
    entityType: "BrandingProfile",
    entityId: existing.id,
    entityName: targetName(target),
    metadata: { before, after: null },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.branding.deleted",
    entityType: "BrandingProfile",
    entityId: existing.id,
    data: { clientId: targetName(target) },
  });
};

/**
 * Before a client is deleted, which cascades to its profile and grants: delete
 * its profile and revoke its active grants, each audited and emitted as the
 * admin API would, and release the profile's images to the grace period.
 * Provisioned or not; a caller that must refuse a provisioned profile checks
 * first. Callers invalidate after commit.
 */
export const deleteClientBrandingTx = async (
  tx: Tx,
  client: { id: string; clientId: string },
  actor: Actor
): Promise<void> => {
  await db.brandingProfiles.lockForWrite({ clientUuid: client.id }, tx);
  // Its row next, as a branding write's foreign key would: a grant added from
  // here on waits, and then finds the client gone.
  await tx.$queryRaw`
    SELECT "id" FROM "auth"."oauth_clients"
    WHERE "id" = ${client.id}::uuid
    FOR UPDATE`;
  const existing = await db.brandingProfiles.getByClientUuid(client.id, tx);
  if (existing) {
    const before = profileRowValues(existing);
    const dropped = imageIds(before);
    await lockImagesTx(tx, dropped);
    await db.brandingProfiles.remove({ clientUuid: client.id }, tx);
    await releaseImagesTx(tx, dropped, new Date());
    await logAuditTx(tx, {
      auth: actor,
      action: "DELETE",
      entityType: "BrandingProfile",
      entityId: existing.id,
      entityName: client.clientId,
      metadata: { before, after: null, reason: "client_deleted" },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.branding.deleted",
      entityType: "BrandingProfile",
      entityId: existing.id,
      data: { clientId: client.clientId },
    });
  }

  // Locked, because a revoke changes no foreign key and so does not wait on
  // the client row: one committing meanwhile makes this wait and re-check.
  const grants = await tx.$queryRaw<{ id: string; userId: string }[]>`
    SELECT "id", "user_id" AS "userId" FROM "auth"."branding_grants"
    WHERE "client_id" = ${client.id}::uuid AND "revoked_at" IS NULL
    ORDER BY "id"
    FOR UPDATE`;
  for (const grant of grants) {
    await logAuditTx(tx, {
      auth: actor,
      action: "DELETE",
      entityType: "BrandingGrant",
      entityId: grant.id,
      entityName: client.clientId,
      metadata: {
        clientId: client.clientId,
        userId: grant.userId,
        reason: "client_deleted",
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.branding.grant-revoked",
      entityType: "BrandingGrant",
      entityId: grant.id,
      data: {
        clientId: client.clientId,
        userId: grant.userId,
        revokedBy: actor.userId,
      },
    });
  }
};

/**
 * Drop cached branding after a committed write. The write stands either way,
 * so a failure is logged, not returned to the caller; replicas catch up when
 * their entries expire, within five minutes.
 */
export const invalidateAfterWrite = async (): Promise<void> => {
  try {
    await invalidateBranding();
  } catch (err) {
    logger.warn({ err }, "Branding saved, but invalidating the cache failed");
  }
};
