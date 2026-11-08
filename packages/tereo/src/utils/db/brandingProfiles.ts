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

/**
 * Client profiles, oldest first: every one, or those of the clients a user
 * owns or holds an active grant on (never the console client's, which only
 * `branding.admin` reads).
 */
export const listClientProfiles = async (
  filter: { all: true } | { readableBy: string; excludeClientId: string }
) => {
  const where: Prisma.BrandingProfileWhereInput =
    "all" in filter
      ? { clientId: { not: null } }
      : {
          client: {
            clientId: { not: filter.excludeClientId },
            OR: [
              { ownerId: filter.readableBy },
              {
                brandingGrants: {
                  some: { userId: filter.readableBy, revokedAt: null },
                },
              },
            ],
          },
        };
  return await prisma.brandingProfile.findMany({
    where,
    select: {
      provisioned: true,
      updatedAt: true,
      client: { select: { id: true, clientId: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
};

/**
 * Clients with no profile yet, by name: every one, or those a user owns or
 * holds an active grant on (never the console client).
 */
export const listBrandableClients = async (
  filter: { all: true } | { editableBy: string; excludeClientId: string }
) => {
  const where: Prisma.OAuthClientWhereInput =
    "all" in filter
      ? { brandingProfile: null }
      : {
          brandingProfile: null,
          clientId: { not: filter.excludeClientId },
          OR: [
            { ownerId: filter.editableBy },
            {
              brandingGrants: {
                some: { userId: filter.editableBy, revokedAt: null },
              },
            },
          ],
        };
  return await prisma.oAuthClient.findMany({
    where,
    select: { id: true, clientId: true, name: true },
    orderBy: [{ name: "asc" }, { clientId: "asc" }],
  });
};

/** Whether the user owns, or actively holds a grant on, any client but the excluded one. */
export const hasEditableClient = async (
  userId: string,
  excludeClientId: string
) => {
  const found = await prisma.oAuthClient.findFirst({
    where: {
      clientId: { not: excludeClientId },
      OR: [
        { ownerId: userId },
        { brandingGrants: { some: { userId, revokedAt: null } } },
      ],
    },
    select: { id: true },
  });
  return found !== null;
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
