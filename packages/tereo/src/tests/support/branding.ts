import type { BrandingImageSlot } from "../../utils/branding/schema.js";
import { storeBrandingImage } from "../../utils/branding/storage.js";
import { SYSTEM_USER_ID } from "../../definitions/systemUser.js";
import { checkImage } from "../../utils/branding/images.js";
import { getTestPrincipalToken } from "./principals.js";
import { randomBytes, randomUUID } from "node:crypto";
import { generateUniqueId } from "./auth/crypto.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "./coreUrl.js";

export const BRANDING_URL = `${CORE_URL}/v1/admin/branding`;

/** A user with a token holding `permissions` (global). */
export const brandingPrincipal = async (permissions: string[]) => {
  const userId = randomUUID();
  const token = await getTestPrincipalToken({ userId, permissions });
  return { userId, token };
};

export const createBrandingClient = async (ownerId: string) => {
  const clientId = `branding-${generateUniqueId()}`;
  return await prisma.oAuthClient.create({
    data: {
      clientId,
      name: `Branding ${clientId}`,
      redirectUris: [],
      scopes: [],
      grantTypes: ["authorization_code"],
      ownerId,
    },
  });
};

export const deleteBrandingClients = async (ids: string[]) => {
  await prisma.oAuthClient.deleteMany({ where: { id: { in: ids } } });
};

export const grantBranding = async (
  clientUuid: string,
  userId: string,
  revoked = false
) => {
  await prisma.brandingGrant.create({
    data: {
      clientId: clientUuid,
      userId,
      grantedBy: SYSTEM_USER_ID,
      ...(revoked && { revokedAt: new Date(), revokedBy: SYSTEM_USER_ID }),
    },
  });
};

/**
 * A stored image, unique to the caller: a 1x1 PNG with `padBytes` random
 * trailing bytes, checked for `slot`.
 */
export const storeTestImage = async (
  slot: BrandingImageSlot = "logo",
  padBytes = 16
) => {
  const base = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  );
  const image = await checkImage(
    slot,
    Buffer.concat([base, randomBytes(padBytes)])
  );
  const stored = await storeBrandingImage(image, SYSTEM_USER_ID);
  return { ...stored, sha256: image.sha256 };
};

export const deleteDefaultProfile = async () => {
  await prisma.brandingProfile.deleteMany({ where: { clientId: null } });
};

/**
 * The test database is the tests' own, so a default left by an earlier run or
 * file is removed rather than the default-profile tests skipping around it.
 */
export const clearDefaultProfile = deleteDefaultProfile;
