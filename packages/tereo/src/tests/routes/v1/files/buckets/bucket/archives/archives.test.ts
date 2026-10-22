// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import env from "../../../../../../../env.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "../../../../../../support/files.js";

describe("POST /v1/files/buckets/:name/archives", () => {
  interface CreateArchiveResponse {
    id: string;
    url: string;
    expiresAt: string;
    objectCount: number;
    totalSizeBytes: string;
    format: "zip" | "tar";
    filename: string;
  }
  let testToken: string;
  let testBucket: { id: number; name: string; policy: string };

  beforeAll(async () => {
    testToken = await getTestAccessToken();
    testBucket = await createTestBucket(testToken, { policy: "private" });

    // Layout under one prefix for prefix-mode tests; two stray objects for
    // multi-select tests.
    await uploadTestObject(
      testToken,
      testBucket.name,
      "docs/readme.txt",
      createTestFile("readme content", "readme.txt", "text/plain")
    );
    await uploadTestObject(
      testToken,
      testBucket.name,
      "docs/guide.txt",
      createTestFile("guide content", "guide.txt", "text/plain")
    );
    await uploadTestObject(
      testToken,
      testBucket.name,
      "top-level.txt",
      createTestFile("top level", "top-level.txt", "text/plain")
    );
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("POST /buckets/:name/archives", () => {
    it("creates an archive snapshot from a prefix", async () => {
      const res = await axios.post<CreateArchiveResponse>(
        `${BASE_URL}/buckets/${testBucket.name}/archives`,
        { prefix: "docs/" },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      expect(res.data.id).toBeDefined();
      expect(res.data.url).toMatch(/\/signed\/archives\//);
      expect(res.data.objectCount).toBe(2);
      expect(res.data.format).toBe("zip");
      expect(res.data.filename).toBe("docs.zip");
    });

    it("creates an archive snapshot from explicit keys", async () => {
      const res = await axios.post<CreateArchiveResponse>(
        `${BASE_URL}/buckets/${testBucket.name}/archives`,
        { keys: ["docs/readme.txt", "top-level.txt"] },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      expect(res.data.objectCount).toBe(2);
    });

    it("rejects a request with both prefix and keys", async () => {
      const res = await axios.post(
        `${BASE_URL}/buckets/${testBucket.name}/archives`,
        { prefix: "docs/", keys: ["top-level.txt"] },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("rejects an empty prefix match", async () => {
      const res = await axios.post(
        `${BASE_URL}/buckets/${testBucket.name}/archives`,
        { prefix: "does-not-exist/" },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("rejects a TTL over the presign maximum without writing anything", async () => {
      const where = { bucketId: testBucket.id };
      const archivesBefore = await prisma.archiveRequest.count({ where });
      const auditWhere = {
        entityType: "archiveRequest",
        metadata: { path: ["bucketName"], equals: testBucket.name },
      };
      const auditBefore = await prisma.auditLogEntry.count({
        where: auditWhere,
      });

      const res = await axios.post(
        `${BASE_URL}/buckets/${testBucket.name}/archives`,
        {
          prefix: "docs/",
          expiresInSeconds: env.FILE_SERVICE_MAX_PRESIGN_TTL_SECONDS + 1,
        },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(res.data.error).toBe("invalid_expiration");

      expect(await prisma.archiveRequest.count({ where })).toBe(archivesBefore);
      expect(await prisma.auditLogEntry.count({ where: auditWhere })).toBe(
        auditBefore
      );
    });
  });
});
