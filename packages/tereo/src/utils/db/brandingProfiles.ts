import { Prisma } from "../../../prisma/generated/client/index.js";
import { prisma } from "./prisma.js";

export type BrandingTarget = { clientUuid: string | null };

export type BrandingProfileData = Omit<
  Prisma.BrandingProfileUncheckedCreateInput,
  "id" | "clientId" | "createdAt" | "updatedAt"
>;

export const getDefault = async (tx?: Prisma.TransactionClient) => {
  return await (tx ?? prisma).brandingProfile.findFirst({
    where: { clientId: null },
  });
};

export const getByClientUuid = async (
  id: string,
  tx?: Prisma.TransactionClient
) => {
  return await (tx ?? prisma).brandingProfile.findUnique({
    where: { clientId: id },
  });
};

export const getByClientIdString = async (
  clientId: string,
  tx?: Prisma.TransactionClient
) => {
  return await (tx ?? prisma).brandingProfile.findFirst({
    where: { client: { clientId } },
  });
};

export const list = async (filter: {
  clientUuids?: string[];
  includeDefault: boolean;
}) => {
  const or: Prisma.BrandingProfileWhereInput[] = [];
  if (filter.includeDefault) or.push({ clientId: null });
  if (filter.clientUuids) or.push({ clientId: { in: filter.clientUuids } });
  if (or.length === 0) return [];
  return await prisma.brandingProfile.findMany({
    where: { OR: or },
    include: { client: { select: { clientId: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
};

/** Create or replace the profile for the target. Call `lockForWrite` first in the same transaction. */
export const upsert = async (
  target: BrandingTarget,
  data: BrandingProfileData,
  tx: Prisma.TransactionClient
) => {
  const existing = target.clientUuid
    ? await getByClientUuid(target.clientUuid, tx)
    : await getDefault(tx);
  if (existing) {
    return await tx.brandingProfile.update({
      where: { id: existing.id },
      data,
    });
  }
  return await tx.brandingProfile.create({
    data: { ...data, clientId: target.clientUuid },
  });
};

export const remove = async (
  target: BrandingTarget,
  tx: Prisma.TransactionClient
) => {
  const { count } = await tx.brandingProfile.deleteMany({
    where: { clientId: target.clientUuid },
  });
  return count > 0;
};

/** Every object a profile references, for the image expiry sweep. */
export const referencedObjectIds = async (
  tx?: Prisma.TransactionClient
): Promise<Set<string>> => {
  const rows = await (tx ?? prisma).brandingProfile.findMany({
    select: {
      logoObjectId: true,
      logoDarkObjectId: true,
      faviconObjectId: true,
      backgroundObjectId: true,
    },
  });
  const ids = new Set<string>();
  for (const row of rows) {
    for (const id of Object.values(row)) if (id) ids.add(id);
  }
  return ids;
};

/**
 * Serialize writers of one target's profile for the rest of the transaction.
 * An advisory lock, because a row lock cannot protect a first save: there is
 * no row to lock yet. Take it before reading the profile.
 */
export const lockForWrite = async (
  target: BrandingTarget,
  tx: Prisma.TransactionClient
) => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`branding:${target.clientUuid ?? "default"}`}, 0))`;
};
