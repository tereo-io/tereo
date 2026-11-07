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

/**
 * True when there is no default profile, so the calling file may create and
 * delete one. A pre-existing default is never touched and
 * the tests that need to own it skip.
 */
export const noDefaultProfile = async () =>
  !(await prisma.brandingProfile.findFirst({ where: { clientId: null } }));

export const deleteDefaultProfile = async () => {
  await prisma.brandingProfile.deleteMany({ where: { clientId: null } });
};
