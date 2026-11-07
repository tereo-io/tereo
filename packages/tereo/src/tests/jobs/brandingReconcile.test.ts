// @module-tag int
// @module-tag auth
// @module-tag job
import { processBrandingReconcile } from "../../jobs/brandingReconcile.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_USER_ID } from "../../definitions/systemUser.js";
import { generateUniqueId } from "../support/auth/crypto.js";
import { checkImage } from "../../utils/branding/images.js";
import { createTestUser } from "../support/auth/users.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import {
  BRANDING_IMAGE_GRACE_MS,
  storeBrandingImage,
} from "../../utils/branding/storage.js";

const uniquePng = async () => {
  const base = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  );
  return await checkImage("logo", Buffer.concat([base, randomBytes(16)]));
};

// Stored images start with an expiry; clear it as a profile reference would.
const storeReferenced = async () => {
  const { objectId } = await storeBrandingImage(
    await uniquePng(),
    SYSTEM_USER_ID
  );
  await prisma.object.update({
    where: { id: objectId },
    data: { deleteAfter: null },
  });
  return objectId;
};

const deleteAfterOf = async (id: string) =>
  (await prisma.object.findUniqueOrThrow({ where: { id } })).deleteAfter;

describe("branding reconcile job", () => {
  const clientUuids: string[] = [];
  const objectIds: string[] = [];
  let ownerId: string;

  const makeProfile = async (logoObjectId: string) => {
    const client = await prisma.oAuthClient.create({
      data: {
        clientId: `reconcile-${generateUniqueId()}`,
        name: "Reconcile test client",
        redirectUris: [],
        scopes: [],
        grantTypes: ["client_credentials"],
        ownerId,
      },
    });
    clientUuids.push(client.id);
    await prisma.brandingProfile.create({
      data: { clientId: client.id, logoObjectId, updatedBy: SYSTEM_USER_ID },
    });
    return client.id;
  };

  beforeAll(async () => {
    ownerId = (await createTestUser()).id;
  });

  afterAll(async () => {
    await prisma.oAuthClient.deleteMany({ where: { id: { in: clientUuids } } });
    await prisma.object.deleteMany({ where: { id: { in: objectIds } } });
  });

  it("marks the images of a deleted client's cascaded profile", async () => {
    const logo = await storeReferenced();
    objectIds.push(logo);
    const clientUuid = await makeProfile(logo);

    const now = new Date();
    await processBrandingReconcile(now);
    expect(await deleteAfterOf(logo)).toBeNull();

    await prisma.oAuthClient.delete({ where: { id: clientUuid } });
    expect(await processBrandingReconcile(now)).toBeGreaterThanOrEqual(1);
    expect((await deleteAfterOf(logo))?.getTime()).toBe(
      now.getTime() + BRANDING_IMAGE_GRACE_MS
    );
  });

  it("leaves an image another profile still references", async () => {
    const shared = await storeReferenced();
    objectIds.push(shared);
    const first = await makeProfile(shared);
    await makeProfile(shared);
    await prisma.oAuthClient.delete({ where: { id: first } });

    await processBrandingReconcile(new Date());
    expect(await deleteAfterOf(shared)).toBeNull();
  });

  it("keeps an expiry that is already set", async () => {
    const id = await storeReferenced();
    objectIds.push(id);
    const earlier = new Date(Date.now() + 60 * 1000);
    await prisma.object.update({
      where: { id },
      data: { deleteAfter: earlier },
    });

    await processBrandingReconcile(new Date());
    expect((await deleteAfterOf(id))?.getTime()).toBe(earlier.getTime());
  });
});
