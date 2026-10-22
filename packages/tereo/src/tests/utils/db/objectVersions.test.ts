// @module-tag int
// @module-tag files
// @module-tag race
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_USER_ID } from "../../../definitions/index.js";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "../../support/files.js";

describe("db.objectVersions.markDeleted", () => {
  let token: string;
  const auth = () => ({
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  const versionedBucket = async () => {
    const bucket = await createTestBucket(token);
    const res = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}`,
      { versioningEnabled: true },
      auth()
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
    return bucket as { id: number; name: string };
  };

  const upload = (bucketName: string, key: string, body: string) =>
    uploadTestObject(
      token,
      bucketName,
      key,
      createTestFile(body, key.split("/").pop(), "text/plain")
    );

  const versions = (objectId: string) =>
    prisma.objectVersion.findMany({
      where: { objectId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });

  describe("deleting a version", () => {
    it("markDeleted claims a version only once", async () => {
      const bucket = await versionedBucket();
      const obj = await upload(bucket.name, "m.txt", `m1 ${randomUUID()}`);
      await upload(bucket.name, "m.txt", `m2 ${randomUUID()}`);
      const [old] = await versions(obj.id);
      const claims = await prisma.$transaction(async (tx) => [
        await db.objectVersions.markDeleted(old.id, SYSTEM_USER_ID, tx),
        await db.objectVersions.markDeleted(old.id, SYSTEM_USER_ID, tx),
      ]);
      expect(claims).toEqual([true, false]);
    });
  });
});
