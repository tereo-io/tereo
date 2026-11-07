// @module-tag int
// @module-tag auth
import { SYSTEM_USER_ID } from "../../../definitions/systemUser.js";
import { checkImage } from "../../../utils/branding/images.js";
import { prisma } from "../../../utils/db/prisma.js";
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  BRANDING_BUCKET,
  BRANDING_IMAGE_GRACE_MS,
  getLiveImageByHash,
  storeBrandingImage,
} from "../../../utils/branding/storage.js";

// A valid 1x1 PNG with a random ancillary chunk so each test owns its hash.
const uniquePng = async () => {
  const base = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  );
  return await checkImage("logo", Buffer.concat([base, randomBytes(16)]));
};

const rowsFor = (sha256: string) =>
  prisma.object.findMany({
    where: {
      bucket: { name: BRANDING_BUCKET },
      objectKey: { startsWith: sha256 },
    },
  });

describe("storeBrandingImage", () => {
  it("stores the same image once and returns the same object", async () => {
    const image = await uniquePng();
    const first = await storeBrandingImage(image, SYSTEM_USER_ID);
    const second = await storeBrandingImage(image, SYSTEM_USER_ID);
    expect(second).toEqual(first);
    expect(first.objectKey).toBe(`${image.sha256}.png`);
    expect(await rowsFor(image.sha256)).toHaveLength(1);
    expect(await getLiveImageByHash(image.sha256)).toEqual(first);
  });

  it("stores concurrent identical uploads once", async () => {
    const image = await uniquePng();
    const [a, b] = await Promise.all([
      storeBrandingImage(image, SYSTEM_USER_ID),
      storeBrandingImage(image, SYSTEM_USER_ID),
    ]);
    expect(a.objectId).toBe(b.objectId);
    expect(await rowsFor(image.sha256)).toHaveLength(1);
  });

  it("expires a new image after the grace period", async () => {
    const image = await uniquePng();
    const { objectId } = await storeBrandingImage(image, SYSTEM_USER_ID);
    const row = await prisma.object.findUniqueOrThrow({
      where: { id: objectId },
    });
    const expected = Date.now() + BRANDING_IMAGE_GRACE_MS;
    expect(row.deleteAfter).not.toBeNull();
    expect(Math.abs(row.deleteAfter!.getTime() - expected)).toBeLessThan(
      60_000
    );
  });

  it("finds nothing for an unknown hash or a deleted object", async () => {
    expect(await getLiveImageByHash("0".repeat(64))).toBeNull();
    const image = await uniquePng();
    const { objectId } = await storeBrandingImage(image, SYSTEM_USER_ID);
    await prisma.object.update({
      where: { id: objectId },
      data: { deletedAt: new Date() },
    });
    expect(await getLiveImageByHash(image.sha256)).toBeNull();
  });

  it("restarts the grace period when an expiring image is stored again", async () => {
    const image = await uniquePng();
    const { objectId } = await storeBrandingImage(image, SYSTEM_USER_ID);
    await prisma.object.update({
      where: { id: objectId },
      data: { deleteAfter: new Date(Date.now() + 60_000) },
    });
    await storeBrandingImage(image, SYSTEM_USER_ID);
    const row = await prisma.object.findUniqueOrThrow({
      where: { id: objectId },
    });
    const expected = Date.now() + BRANDING_IMAGE_GRACE_MS;
    expect(Math.abs(row.deleteAfter!.getTime() - expected)).toBeLessThan(
      60_000
    );
  });

  it("leaves a referenced image's expiry null when stored again", async () => {
    const image = await uniquePng();
    const { objectId } = await storeBrandingImage(image, SYSTEM_USER_ID);
    await prisma.object.update({
      where: { id: objectId },
      data: { deleteAfter: null },
    });
    await storeBrandingImage(image, SYSTEM_USER_ID);
    const row = await prisma.object.findUniqueOrThrow({
      where: { id: objectId },
    });
    expect(row.deleteAfter).toBeNull();
  });
});
