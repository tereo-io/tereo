// @module-tag int
// @module-tag files
import { getTestPrincipalToken } from "../../../../../../../../../support/principals.js";
import { prisma } from "../../../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  getTestUserId,
  uploadTestObject,
} from "../../../../../../../../../support/files.js";

describe("GET /v1/files/buckets/:name/objects/by-id/:id/versions", () => {
  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
  let testToken: string;

  beforeAll(async () => {
    testToken = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("Versioning", () => {
    it("resolves each version's createdBy to the writer's email and name", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/json",
          },
        }
      );

      const otherToken = await getTestPrincipalToken({
        permissions: ["file-service.admin"],
      });
      const otherUserId = JSON.parse(
        Buffer.from(otherToken.split(".")[1], "base64url").toString()
      ).sub as string;

      const key = "two-writers.txt";
      const v1 = await uploadTestObject(
        testToken,
        bucket.name,
        key,
        createTestFile("one", "one.txt", "text/plain")
      );
      await uploadTestObject(
        otherToken,
        bucket.name,
        key,
        createTestFile("two", "two.txt", "text/plain")
      );

      const listRes = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${v1.id}/versions`,
        { headers: authHeader(testToken) }
      );
      expect(listRes.status).toBe(HTTP_STATUS.OK);

      const writers = await prisma.user.findMany({
        where: { id: { in: [getTestUserId(), otherUserId] } },
      });
      expect(writers).toHaveLength(2);
      const rows = listRes.data.data as Array<{
        isCurrent: boolean;
        createdBy: string;
        createdByEmail: string | null;
        createdByName: string | null;
      }>;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const writer = writers.find((u) => u.id === row.createdBy);
        expect(writer).toBeDefined();
        expect(row.createdByEmail).toBe(writer!.email);
        expect(row.createdByName).toBe(writer!.name);
      }
      expect(rows.find((r) => r.isCurrent)?.createdBy).toBe(otherUserId);
      expect(rows.find((r) => !r.isCurrent)?.createdBy).toBe(getTestUserId());
    });
  });
});
