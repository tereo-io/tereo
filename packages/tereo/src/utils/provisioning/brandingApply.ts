import { ProvisioningError, type ProvisioningSet } from "./load.js";
import { BRANDING_IMAGE_SLOTS } from "../branding/schema.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { storeBrandingImage } from "../branding/storage.js";
import type { LoadedProfile } from "./branding.js";
import type { Prisma } from "../db/prisma.js";
import { logAuditTx } from "../outbox.js";
import db from "../db/index.js";
import {
  type AdminProfileValues,
  changedSlots,
  profileRowValues,
  saveProfileTx,
} from "../branding/write.js";

type Tx = Prisma.TransactionClient;

const SYSTEM_ACTOR = { userId: SYSTEM_USER_ID, email: null };

const declaredProfiles = (set: ProvisioningSet) =>
  set.documents.flatMap(({ file, branding }) =>
    branding
      ? [
          ...(branding.default
            ? [{ file, clientId: null, profile: branding.default }]
            : []),
          ...Object.entries(branding.clients).map(([clientId, profile]) => ({
            file,
            clientId: clientId as string | null,
            profile,
          })),
        ]
      : []
  );

/**
 * Store every declared image, reusing a live object with the same content.
 * Outside the transaction, like an upload: one never referenced expires
 * after the grace period. Returns sha256 → object id.
 */
export const storeProvisionedImages = async (
  set: ProvisioningSet
): Promise<Map<string, string>> => {
  const objectIds = new Map<string, string>();
  for (const { profile } of declaredProfiles(set))
    for (const slot of BRANDING_IMAGE_SLOTS) {
      const image = profile[slot];
      if (!image || objectIds.has(image.sha256)) continue;
      const stored = await storeBrandingImage(image, SYSTEM_USER_ID);
      objectIds.set(image.sha256, stored.objectId);
    }
  return objectIds;
};

const valuesOf = (
  profile: LoadedProfile,
  objectIds: Map<string, string>
): AdminProfileValues => {
  const values = { ...profile } as unknown as AdminProfileValues;
  for (const slot of BRANDING_IMAGE_SLOTS) {
    const image = profile[slot];
    values[slot] = image ? objectIds.get(image.sha256)! : null;
  }
  return values;
};

/**
 * Write each declared profile whole as provisioned, skipping one already
 * identical; a profile provisioned before and no longer declared keeps its
 * values and goes back to the admin API. Run after the set's clients are
 * written. Adds `"default"` or the client id of each profile changed to
 * `result.branding`.
 */
export const applyBranding = async (
  tx: Tx,
  set: ProvisioningSet,
  objectIds: Map<string, string>,
  result: { branding: string[] }
): Promise<void> => {
  const declared = declaredProfiles(set);
  const clientIds = declared.flatMap((d) => (d.clientId ? [d.clientId] : []));
  const clients = new Map(
    (
      await tx.oAuthClient.findMany({
        where: { clientId: { in: clientIds } },
        select: { id: true, clientId: true },
      })
    ).map((c) => [c.clientId, c])
  );
  const unknown = declared.filter(
    (d) => d.clientId !== null && !clients.has(d.clientId)
  );
  if (unknown.length > 0)
    throw new ProvisioningError(
      unknown.map(
        ({ file, clientId }) =>
          `${file}: branding.clients[${clientId}]: no client "${clientId}" in the provisioning set or the database`
      )
    );

  for (const { file, clientId, profile } of declared) {
    const target = { client: clientId ? clients.get(clientId)! : null };
    const values = valuesOf(profile, objectIds);
    const clientUuid = target.client?.id ?? null;
    await db.brandingProfiles.lockForWrite({ clientUuid }, tx);
    const existing = clientUuid
      ? await db.brandingProfiles.getByClientUuid(clientUuid, tx)
      : await db.brandingProfiles.getDefault(tx);
    if (
      existing?.provisioned &&
      existing.provisionedFrom === file &&
      changedSlots(profileRowValues(existing), values).length === 0
    )
      continue;
    await saveProfileTx(tx, target, values, SYSTEM_ACTOR, file);
    result.branding.push(clientId ?? "default");
  }

  const stillDeclared = new Set(declared.map((d) => d.clientId));
  const released = await tx.brandingProfile.findMany({
    where: { provisioned: true },
    select: {
      id: true,
      clientId: true,
      provisionedFrom: true,
      client: { select: { clientId: true } },
    },
  });
  for (const row of released) {
    const name = row.client?.clientId ?? null;
    if (stillDeclared.has(name)) continue;
    await db.brandingProfiles.lockForWrite({ clientUuid: row.clientId }, tx);
    await tx.brandingProfile.update({
      where: { id: row.id },
      data: { provisioned: false, provisionedFrom: null },
    });
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      action: "UPDATE",
      entityType: "BrandingProfile",
      entityId: row.id,
      entityName: name ?? "default",
      changes: {
        provisioned: { old: true, new: false },
        provisionedFrom: { old: row.provisionedFrom, new: null },
      },
      metadata: { action: "unprovisioned" },
    });
    result.branding.push(name ?? "default");
  }
};
