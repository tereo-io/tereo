// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("GET /v1/files/buckets/:name/objects", () => {
  describe("Object Management", () => {
    interface ObjectResponse {
      id: string;
      key: string;
      contentType: string;
      sizeBytes: string;
      etag: string;
      metadata?: Record<string, unknown>;
      createdAt: string;
      updatedAt?: string;
    }

    interface ObjectsListResponse {
      data: ObjectResponse[];
      hasMore: boolean;
      limit: number;
      nextCursor: string | null;
    }
    let testToken: string;
    let testBucket: { id: number; name: string; policy: string };

    beforeAll(async () => {
      testToken = await getTestAccessToken();
      testBucket = await createTestBucket(testToken, { policy: "private" });
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("Enhanced Pagination and Sorting", () => {
      // Its own bucket, so the sorts are checked against exactly these three:
      // by key aaa, mmm, zzz; by upload time aaa, zzz, mmm; by size zzz, mmm,
      // aaa.
      let sortBucket: { name: string };

      beforeAll(async () => {
        sortBucket = await createTestBucket(testToken, { policy: "private" });
        const uploads: Array<[string, string]> = [
          ["aaa-file.txt", "content 333"],
          ["zzz-file.txt", "content 1"],
          ["mmm-file.txt", "content 22"],
        ];
        for (const [key, content] of uploads) {
          const file = createTestFile(content, key, "text/plain");
          await uploadTestObject(testToken, testBucket.name, key, file);
          await uploadTestObject(testToken, sortBucket.name, key, file);
          // Distinct createdAt values.
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      });

      it.each([
        ["objectKey", "asc", ["aaa-file.txt", "mmm-file.txt", "zzz-file.txt"]],
        ["objectKey", "desc", ["zzz-file.txt", "mmm-file.txt", "aaa-file.txt"]],
        ["createdAt", "asc", ["aaa-file.txt", "zzz-file.txt", "mmm-file.txt"]],
        ["createdAt", "desc", ["mmm-file.txt", "zzz-file.txt", "aaa-file.txt"]],
        ["sizeBytes", "asc", ["zzz-file.txt", "mmm-file.txt", "aaa-file.txt"]],
        ["sizeBytes", "desc", ["aaa-file.txt", "mmm-file.txt", "zzz-file.txt"]],
      ])("sorts by %s %s", async (sort, sortDir, expected) => {
        const response = await axios.get(
          `${BASE_URL}/buckets/${sortBucket.name}/objects`,
          {
            params: { sort, sortDir },
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(
          response.data.data.map((obj: { key: string }) => obj.key)
        ).toEqual(expected);
      });

      it("should respect limit parameter (minimum 1)", async () => {
        const response = await axios.get(
          `${BASE_URL}/buckets/${testBucket.name}/objects?limit=2`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.data.length).toBeLessThanOrEqual(2);
        expect(response.data.limit).toBe(2);
      });

      it("should respect maximum limit of 1000", async () => {
        const response = await axios.get(
          `${BASE_URL}/buckets/${testBucket.name}/objects?limit=1001`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });

      it("should walk through pages via cursor", async () => {
        const firstPage = await axios.get<ObjectsListResponse>(
          `${BASE_URL}/buckets/${testBucket.name}/objects?limit=1`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        expect(firstPage.status).toBe(HTTP_STATUS.OK);
        expect(firstPage.data.hasMore).toBe(true);
        expect(firstPage.data.nextCursor).toEqual(expect.any(String));

        const secondPage = await axios.get<ObjectsListResponse>(
          `${BASE_URL}/buckets/${testBucket.name}/objects?limit=1&cursor=${encodeURIComponent(firstPage.data.nextCursor!)}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        expect(secondPage.status).toBe(HTTP_STATUS.OK);
        expect(firstPage.data.data).toHaveLength(1);
        expect(secondPage.data.data).toHaveLength(1);
        expect(firstPage.data.data[0].id).not.toBe(secondPage.data.data[0].id);
      });

      it("should reject a malformed cursor with 400", async () => {
        const response = await axios.get(
          `${BASE_URL}/buckets/${testBucket.name}/objects?limit=5&cursor=not-a-real-cursor`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });

      it("should correctly report hasMore flag", async () => {
        // With many objects seeded above, limiting to 1 should set hasMore=true.
        const limitedResponse = await axios.get<ObjectsListResponse>(
          `${BASE_URL}/buckets/${testBucket.name}/objects?limit=1`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(limitedResponse.status).toBe(HTTP_STATUS.OK);
        expect(limitedResponse.data.data).toHaveLength(1);
        expect(limitedResponse.data.hasMore).toBe(true);
        expect(limitedResponse.data.nextCursor).not.toBeNull();
      });

      it("should return hasMore as false when at end of results", async () => {
        const response = await axios.get(
          `${BASE_URL}/buckets/${testBucket.name}/objects?limit=1000`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.hasMore).toBe(false);
      });
    });
  });

  describe("object list filters", () => {
    let token: string;
    let bucketName: string;

    const list = (params: Record<string, string>) =>
      axios.get(`${BASE_URL}/buckets/${bucketName}/objects`, {
        params,
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

    beforeAll(async () => {
      token = await getTestAccessToken();
      bucketName = (await createTestBucket(token)).name;
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("refuses an objectKey filter longer than a key", async () => {
      expect(
        (await list({ "filter[objectKey]": "k".repeat(1024) })).status
      ).toBe(HTTP_STATUS.OK);
      expect(
        (await list({ "filter[objectKey]": "k".repeat(1025) })).status
      ).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("refuses a contentType filter longer than a content type", async () => {
      const res = await list({
        "filter[contentType]": "t".repeat(256),
        "filter[contentType_op]": "contains",
      });
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });
});
