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
  uploadTestObjectAndGetId,
} from "../../../../../../../../../support/files.js";

describe("POST /v1/files/buckets/:name/objects/by-id/:id/presign", () => {
  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
  let testToken: string;

  beforeAll(async () => {
    testToken = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("Presigned URLs", () => {
    it("generates a signed URL and downloads through it without auth", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const uploaded = await uploadTestObject(
        testToken,
        bucket.name,
        "signed.txt",
        createTestFile("signed-data", "signed.txt", "text/plain")
      );

      const presign = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${uploaded.id}/presign`,
        { operation: "read", expiresInSeconds: 60 },
        { headers: authHeader(testToken) }
      );
      expect(presign.status).toBe(HTTP_STATUS.OK);
      expect(presign.data.url).toContain("/signed/objects/");

      const res = await axios.get(presign.data.url, {
        validateStatus: () => true,
      });
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data).toBe("signed-data");
    });

    it("rejects a signed URL with a tampered signature", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const uploaded = await uploadTestObject(
        testToken,
        bucket.name,
        "sign-bad.txt",
        createTestFile("x", "sign-bad.txt", "text/plain")
      );

      const presign = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${uploaded.id}/presign`,
        { operation: "read", expiresInSeconds: 60 },
        { headers: authHeader(testToken) }
      );
      const url = new URL(presign.data.url);
      const sig = url.searchParams.get("sig")!;
      const tampered = sig.replace(/.$/, (c) => (c === "a" ? "b" : "a"));
      url.searchParams.set("sig", tampered);

      const res = await axios.get(url.toString(), {
        validateStatus: () => true,
      });
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("points presigned URLs under /v1/files", async () => {
      const bucket = await createTestBucket(testToken);
      const file = createTestFile("hello", "hello.txt", "text/plain");
      const id = await uploadTestObjectAndGetId(
        testToken,
        bucket.name,
        "hello.txt",
        file
      );
      const presign = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${id}/presign`,
        { operation: "read", expiresInSeconds: 60 },
        {
          headers: authHeader(testToken),
          validateStatus: () => true,
        }
      );
      expect(presign.status).toBe(200);
      expect(new URL(presign.data.url).pathname).toMatch(
        /^\/v1\/files\/signed\//
      );

      const download = await axios.get(presign.data.url, {
        responseType: "text",
        validateStatus: () => true,
      });
      expect(download.status).toBe(200);
      expect(download.data).toBe("hello");
    });
  });
});
