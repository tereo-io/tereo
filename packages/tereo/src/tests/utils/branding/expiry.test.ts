// @module-tag int
// @module-tag auth
import { SYSTEM_USER_ID } from "../../../definitions/systemUser.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateUniqueId } from "../../support/auth/crypto.js";
import { checkImage } from "../../../utils/branding/images.js";
import { createTestUser } from "../../support/auth/users.js";
import { BadRequestError } from "../../../utils/errors.js";
import { prisma } from "../../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import {
  BRANDING_IMAGE_GRACE_MS,
  storeBrandingImage,
} from "../../../utils/branding/storage.js";
import {
  referenceImagesTx,
  releaseImagesTx,
} from "../../../utils/branding/expiry.js";

const uniquePng = async () => {
  const base = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  );
  return await checkImage("logo", Buffer.concat([base, randomBytes(16)]));
};

const store = async () =>
  (await storeBrandingImage(await uniquePng(), SYSTEM_USER_ID)).objectId;

const deleteAfterOf = async (id: string) =>
  (await prisma.object.findUniqueOrThrow({ where: { id } })).deleteAfter;

describe("branding image expiry", () => {
  const clientUuids: string[] = [];
  let ownerId: string;

  // Client-bound profiles, so these tests never touch the default singleton.
  const makeProfile = async (logoObjectId: string | null) => {
    const client = await prisma.oAuthClient.create({
      data: {
        clientId: `expiry-${generateUniqueId()}`,
        name: "Expiry test client",
        redirectUris: [],
        scopes: [],
        grantTypes: ["client_credentials"],
        ownerId,
      },
    });
    clientUuids.push(client.id);
    return await prisma.brandingProfile.create({
      data: { clientId: client.id, logoObjectId, updatedBy: SYSTEM_USER_ID },
    });
  };

  beforeAll(async () => {
    ownerId = (await createTestUser()).id;
  });

  afterAll(async () => {
    await prisma.oAuthClient.deleteMany({ where: { id: { in: clientUuids } } });
  });

  it("referenceImagesTx clears delete_after", async () => {
    const id = await store();
    expect(await deleteAfterOf(id)).not.toBeNull();
    await prisma.$transaction((tx) => referenceImagesTx(tx, [id]));
    expect(await deleteAfterOf(id)).toBeNull();
  });

  it("referenceImagesTx rejects a soft-deleted or unknown object", async () => {
    const id = await store();
    await prisma.object.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    const err = await prisma
      .$transaction((tx) => referenceImagesTx(tx, [id]))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).statusCode).toBe(400);
    await expect(
      prisma.$transaction((tx) =>
        referenceImagesTx(tx, ["00000000-0000-4000-8000-000000000000"])
      )
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("referenceImagesTx rejects an object outside the branding bucket", async () => {
    const bucket = await prisma.bucket.create({
      data: {
        name: `test-bucket-expiry-${generateUniqueId()}`,
        createdBy: SYSTEM_USER_ID,
        ownerId: SYSTEM_USER_ID,
      },
    });
    const other = await prisma.object.create({
      data: {
        bucketId: bucket.id,
        objectKey: "x.png",
        createdBy: SYSTEM_USER_ID,
      },
    });
    await expect(
      prisma.$transaction((tx) => referenceImagesTx(tx, [other.id]))
    ).rejects.toBeInstanceOf(BadRequestError);
    await prisma.bucket.delete({ where: { id: bucket.id } });
  });

  it("releaseImagesTx leaves an image another profile references", async () => {
    const id = await store();
    await prisma.$transaction((tx) => referenceImagesTx(tx, [id]));
    await makeProfile(id);
    await prisma.$transaction((tx) => releaseImagesTx(tx, [id], new Date()));
    expect(await deleteAfterOf(id)).toBeNull();
  });

  it("releaseImagesTx starts the clock on an unreferenced image", async () => {
    const id = await store();
    await prisma.$transaction((tx) => referenceImagesTx(tx, [id]));
    const now = new Date();
    await prisma.$transaction((tx) => releaseImagesTx(tx, [id], now));
    const after = await deleteAfterOf(id);
    expect(after!.getTime()).toBe(now.getTime() + BRANDING_IMAGE_GRACE_MS);
  });

  // Review Focus 2: a replaced image stays live for the grace period.
  it("keeps a replaced image live for 24 h", async () => {
    const a = await store();
    const b = await store();
    const profile = await makeProfile(null);

    await prisma.$transaction(async (tx) => {
      await referenceImagesTx(tx, [a]);
      await tx.brandingProfile.update({
        where: { id: profile.id },
        data: { logoObjectId: a },
      });
    });
    expect(await deleteAfterOf(a)).toBeNull();

    await prisma.$transaction(async (tx) => {
      await referenceImagesTx(tx, [b]);
      await tx.brandingProfile.update({
        where: { id: profile.id },
        data: { logoObjectId: b },
      });
      await releaseImagesTx(tx, [a], new Date());
    });

    const row = await prisma.object.findUniqueOrThrow({ where: { id: a } });
    expect(row.deletedAt).toBeNull();
    const expected = Date.now() + BRANDING_IMAGE_GRACE_MS;
    expect(Math.abs(row.deleteAfter!.getTime() - expected)).toBeLessThan(
      60_000
    );
    expect(await deleteAfterOf(b)).toBeNull();
  });
});
