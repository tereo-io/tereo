// @module-tag int
// @module-tag files
// @module-tag race
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import {
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
} from "../../support/files.js";

describe("db.buckets.update", () => {
  let testToken: string;

  beforeAll(async () => {
    testToken = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("bucket races and limits", () => {
    it("does not update a bucket deleted since it was read", async () => {
      const bucket = await createTestBucket(testToken);
      await prisma.bucket.update({
        where: { id: bucket.id },
        data: { deletedAt: new Date() },
      });
      await expect(
        db.buckets.update(bucket.id, { description: "after delete" })
      ).rejects.toMatchObject({ statusCode: 404 });
      const row = await prisma.bucket.findUniqueOrThrow({
        where: { id: bucket.id },
      });
      expect(row.description).not.toBe("after delete");
    });
  });
});
