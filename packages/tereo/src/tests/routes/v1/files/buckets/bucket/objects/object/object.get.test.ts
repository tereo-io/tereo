// @module-tag int
// @module-tag files
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
} from "../../../../../../../support/files.js";

describe("GET and HEAD /v1/files/buckets/:name/objects/*objectKey", () => {
  describe("Object Management", () => {
    let testToken: string;
    let testBucket: { id: number; name: string; policy: string };

    beforeAll(async () => {
      testToken = await getTestAccessToken();
      testBucket = await createTestBucket(testToken, { policy: "private" });
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("GET /buckets/:name/objects/*", () => {
      it("should download an object", async () => {
        const content = "Download test content";
        const file = createTestFile(content, "download.txt", "text/plain");
        const objectKey = "download-test.txt";

        await uploadTestObject(testToken, testBucket.name, objectKey, file);

        const response = await axios.get(
          `${BASE_URL}/buckets/${testBucket.name}/objects/${objectKey}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
            responseType: "text",
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.headers["content-type"]).toBe("text/plain");
        expect(response.headers["etag"]).toBeDefined();
        expect(response.headers["last-modified"]).toBeDefined();
        expect(response.headers["cache-control"]).toBeDefined();

        const downloadedContent = response.data;
        expect(downloadedContent).toBe(content);
      });

      it("should return 404 for non-existent object", async () => {
        const response = await axios.get(
          `${BASE_URL}/buckets/${testBucket.name}/objects/non-existent.txt`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });
    });

    describe("HEAD /buckets/:name/objects/*", () => {
      it("should get object metadata without content", async () => {
        const file = createTestFile("Metadata test", "meta.txt", "text/plain");
        const objectKey = "metadata-test.txt";

        await uploadTestObject(testToken, testBucket.name, objectKey, file);

        const response = await axios.head(
          `${BASE_URL}/buckets/${testBucket.name}/objects/${objectKey}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.headers["content-type"]).toBe("text/plain");
        expect(response.headers["content-length"]).toBeDefined();
        expect(response.headers["etag"]).toBeDefined();
        expect(response.headers["last-modified"]).toBeDefined();

        // HEAD should not return body
        expect(response.data).toBe("");
      });

      it("should return 404 for non-existent object", async () => {
        const response = await axios.head(
          `${BASE_URL}/buckets/${testBucket.name}/objects/non-existent.txt`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });
    });
  });

  describe("File Service Overhaul — end-to-end flows", () => {
    const authHeader = (token: string) => ({
      Authorization: `Bearer ${token}`,
    });
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("ETag conditional requests", () => {
      it("returns 304 on GET with matching If-None-Match", async () => {
        const bucket = await createTestBucket(testToken, { policy: "private" });
        const upload = await uploadTestObject(
          testToken,
          bucket.name,
          "etag-test.txt",
          createTestFile("hello", "etag-test.txt", "text/plain")
        );

        const res = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/etag-test.txt`,
          {
            headers: {
              ...authHeader(testToken),
              "If-None-Match": `"${upload.etag}"`,
            },
            validateStatus: () => true,
          }
        );
        expect(res.status).toBe(304);
      });
    });
  });

  describe("Conditional writes and download caching", () => {
    let token: string;

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("Cache-Control on downloads", () => {
      it("keeps a private bucket out of shared caches and revalidates current content", async () => {
        const bucket = await createTestBucket(token, { policy: "private" });
        await uploadTestObject(
          token,
          bucket.name,
          "a.txt",
          createTestFile(`a ${randomUUID()}`)
        );
        const res = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/a.txt`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        expect(res.headers["cache-control"]).toBe("private, no-cache");
      });

      it("lets a public bucket be cached, and a pinned version for good", async () => {
        const bucket = await createTestBucket(token, { policy: "public" });
        await axios.put(
          `${BASE_URL}/buckets/${bucket.name}`,
          { versioningEnabled: true },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const object = await uploadTestObject(
          token,
          bucket.name,
          "a.txt",
          createTestFile(`a ${randomUUID()}`)
        );
        const current = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/a.txt`
        );
        expect(current.headers["cache-control"]).toBe("public, no-cache");

        const versions = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${object.id}/versions`
        );
        const versionId = versions.data.data[0].versionId;
        const pinned = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/a.txt?versionId=${versionId}`
        );
        expect(pinned.headers["cache-control"]).toBe(
          "public, max-age=31536000, immutable"
        );
      });
    });
  });

  describe("download responses", () => {
    const text = (content: string) => createTestFile(content, "a.txt");

    const expectJsonErrorHeaders = (headers: Record<string, unknown>) => {
      expect(headers["content-type"]).toMatch(/^application\/json/);
      expect(headers["cache-control"]).toBe("no-store");
      expect(headers["content-disposition"]).toBeUndefined();
      // Express tags the JSON body itself, weakly; the file's tag is strong.
      expect(String(headers.etag ?? "W/")).toMatch(/^W\//);
      expect(headers["last-modified"]).toBeUndefined();
    };
    let token: string;
    let bucket: { id: number; name: string };
    let objectId: string;
    let firstVersion: { id: string; etag: string | null };
    let current: { id: string; etag: string | null };
    const url = () => `${BASE_URL}/buckets/${bucket.name}/objects/doc.txt`;

    const req = (
      method: "get" | "head",
      target: string,
      headers: Record<string, string> = {},
      params: Record<string, string> = {}
    ) =>
      axios.request({
        method,
        url: target,
        params,
        headers: { Authorization: `Bearer ${token}`, ...headers },
        validateStatus: () => true,
      });

    beforeAll(async () => {
      token = await getTestAccessToken();
      bucket = await createTestBucket(token);
      await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      objectId = (
        await uploadTestObject(token, bucket.name, "doc.txt", text("first one"))
      ).id;
      await uploadTestObject(
        token,
        bucket.name,
        "doc.txt",
        text("second, longer")
      );
      const versions = await prisma.objectVersion.findMany({
        where: { objectId },
        orderBy: { createdAt: "asc" },
      });
      [firstVersion, current] = versions;
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("HEAD", () => {
      const compared = [
        "content-type",
        "content-length",
        "etag",
        "last-modified",
        "cache-control",
        "content-disposition",
        "content-security-policy",
        "x-content-type-options",
        "accept-ranges",
        "x-object-id",
      ];

      it("describes the version ?versionId= names, as GET serves it", async () => {
        const params = { versionId: firstVersion.id };
        const get = await req("get", url(), {}, params);
        const head = await req("head", url(), {}, params);
        expect(head.status).toBe(HTTP_STATUS.OK);
        for (const name of compared) {
          expect([name, head.headers[name]]).toEqual([name, get.headers[name]]);
        }
        expect(head.headers.etag).toBe(`"${firstVersion.etag}"`);
        expect(head.headers["content-length"]).toBe("9");
        expect(head.headers["cache-control"]).toContain("immutable");
      });

      it("answers a failed If-Match with 412", async () => {
        const res = await req("head", url(), { "If-Match": '"nope"' });
        expect(res.status).toBe(412);
      });
    });

    describe("preconditions", () => {
      const versionUrl = (versionId: string) =>
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${versionId}/download`;

      it("answers If-Modified-Since with 304 once nothing changed since", async () => {
        const later = new Date(Date.now() + 60_000).toUTCString();
        for (const target of [url(), versionUrl(firstVersion.id)]) {
          const res = await req("get", target, { "If-Modified-Since": later });
          expect([target, res.status]).toEqual([target, 304]);
          expect(res.headers.etag).toBeDefined();
        }
        const earlier = new Date(0).toUTCString();
        const res = await req("get", url(), { "If-Modified-Since": earlier });
        expect(res.status).toBe(HTTP_STATUS.OK);
      });

      it("lets If-None-Match override If-Modified-Since", async () => {
        const later = new Date(Date.now() + 60_000).toUTCString();
        const res = await req("get", url(), {
          "If-None-Match": '"other"',
          "If-Modified-Since": later,
        });
        expect(res.status).toBe(HTTP_STATUS.OK);
      });

      it("answers If-Unmodified-Since before the last change with 412", async () => {
        const res = await req("get", versionUrl(firstVersion.id), {
          "If-Unmodified-Since": new Date(0).toUTCString(),
        });
        expect(res.status).toBe(412);
        expectJsonErrorHeaders(res.headers);
      });

      it("never matches a weak tag in If-Match", async () => {
        const weak = await req("get", url(), {
          "If-Match": `W/"${current.etag}"`,
        });
        expect(weak.status).toBe(412);
        const strong = await req("get", url(), {
          "If-Match": `"${current.etag}"`,
        });
        expect(strong.status).toBe(HTTP_STATUS.OK);
      });
    });
  });

  describe("Range downloads", () => {
    const patterned = (size: number) => {
      const buf = Buffer.alloc(size);
      for (let i = 0; i < size; i++) buf[i] = 32 + ((i * 7) % 90);
      return buf;
    };

    const binary = (buffer: Buffer, filename = "f.bin") => ({
      buffer,
      filename,
      contentType: "application/octet-stream",
    });
    let token: string;
    const content = Buffer.from(
      `${randomUUID()}${randomUUID()}${randomUUID()}`.slice(0, 100)
    );
    let bucket: { id: number; name: string };
    let objectId: string;
    let url: string;

    const get = (
      target: string,
      headers: Record<string, string> = {},
      withAuth = true
    ) =>
      axios.get<ArrayBuffer>(target, {
        headers: {
          ...(withAuth ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        responseType: "arraybuffer",
        validateStatus: () => true,
      });

    const body = (res: { data: ArrayBuffer }) => Buffer.from(res.data);

    beforeAll(async () => {
      token = await getTestAccessToken();
      bucket = await createTestBucket(token);
      objectId = (
        await uploadTestObject(token, bucket.name, "r.bin", binary(content))
      ).id;
      url = `${BASE_URL}/buckets/${bucket.name}/objects/r.bin`;
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("serves one range as 206 with Content-Range", async () => {
      const res = await get(url, { Range: "bytes=10-19" });
      expect(res.status).toBe(206);
      expect(res.headers["content-range"]).toBe("bytes 10-19/100");
      expect(res.headers["content-length"]).toBe("10");
      expect(res.headers["accept-ranges"]).toBe("bytes");
      expect(body(res)).toEqual(content.subarray(10, 20));
    });

    it("serves open-ended and suffix ranges, clamped to the content", async () => {
      const open = await get(url, { Range: "bytes=95-" });
      expect(open.status).toBe(206);
      expect(body(open)).toEqual(content.subarray(95));
      const suffix = await get(url, { Range: "bytes=-5" });
      expect(suffix.headers["content-range"]).toBe("bytes 95-99/100");
      expect(body(suffix)).toEqual(content.subarray(95));
      const past = await get(url, { Range: "bytes=90-1000" });
      expect(past.headers["content-range"]).toBe("bytes 90-99/100");
    });

    it("answers 416 for a range past the end", async () => {
      const res = await get(url, { Range: "bytes=100-" });
      expect(res.status).toBe(416);
      expect(res.headers["content-range"]).toBe("bytes */100");
    });

    it("sends the whole body for several ranges or a malformed one", async () => {
      for (const range of ["bytes=0-1,5-6", "bytes=abc", "items=0-5"]) {
        const res = await get(url, { Range: range });
        expect([range, res.status]).toEqual([range, HTTP_STATUS.OK]);
        expect(body(res)).toEqual(content);
      }
    });

    it("honours If-Range only while the validator still matches", async () => {
      // A date validator is strong only once it is a second old.
      await prisma.object.update({
        where: { id: objectId },
        data: { updatedAt: new Date(Date.now() - 10_000) },
      });
      const full = await get(url);
      expect(full.headers["accept-ranges"]).toBe("bytes");
      const etag = full.headers.etag as string;
      const lastModified = full.headers["last-modified"] as string;

      const same = await get(url, { Range: "bytes=0-3", "If-Range": etag });
      expect(same.status).toBe(206);
      const byDate = await get(url, {
        Range: "bytes=0-3",
        "If-Range": lastModified,
      });
      expect(byDate.status).toBe(206);

      const stale = await get(url, { Range: "bytes=0-3", "If-Range": '"x"' });
      expect(stale.status).toBe(HTTP_STATUS.OK);
      expect(body(stale)).toEqual(content);
      const weak = await get(url, {
        Range: "bytes=0-3",
        "If-Range": `W/${etag}`,
      });
      expect(weak.status).toBe(HTTP_STATUS.OK);
      const older = await get(url, {
        Range: "bytes=0-3",
        "If-Range": new Date(0).toUTCString(),
      });
      expect(older.status).toBe(HTTP_STATUS.OK);
    });

    it("ignores an If-Range date from the second the response is sent in", async () => {
      // Ahead of the clock, so the request cannot cross into a later second.
      await prisma.object.update({
        where: { id: objectId },
        data: { updatedAt: new Date(Date.now() + 5_000) },
      });
      const lastModified = (await get(url)).headers["last-modified"] as string;
      const res = await get(url, {
        Range: "bytes=0-3",
        "If-Range": lastModified,
      });
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(body(res)).toEqual(content);
    });

    it("keeps If-None-Match ahead of Range", async () => {
      const etag = (await get(url)).headers.etag as string;
      const res = await get(url, { Range: "bytes=0-3", "If-None-Match": etag });
      expect(res.status).toBe(304);
    });

    it("advertises ranges on HEAD", async () => {
      const res = await axios.head(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.headers["accept-ranges"]).toBe("bytes");
    });

    it("serves ranges of a public bucket's object without a token", async () => {
      const open = await createTestBucket(token, { policy: "public" });
      await uploadTestObject(token, open.name, "p.bin", binary(content));
      const res = await get(
        `${BASE_URL}/buckets/${open.name}/objects/p.bin`,
        { Range: "bytes=0-0" },
        false
      );
      expect(res.status).toBe(206);
      expect(body(res)).toEqual(content.subarray(0, 1));
    });

    it("decrypts ranges from the middle of a blob too large to verify whole", async () => {
      const size = 17 * 1024 * 1024 + 123;
      const big = patterned(size);
      await uploadTestObject(token, bucket.name, "big.bin", binary(big));
      const bigUrl = `${BASE_URL}/buckets/${bucket.name}/objects/big.bin`;

      for (const [start, end] of [
        [0, 15],
        [16, 31],
        [5, 40_000],
        [1_000_003, 2_000_017],
        [size - 100, size - 1],
      ]) {
        const res = await get(bigUrl, { Range: `bytes=${start}-${end}` });
        expect(res.status).toBe(206);
        expect(res.headers["content-range"]).toBe(
          `bytes ${start}-${end}/${size}`
        );
        expect(body(res).equals(big.subarray(start, end + 1))).toBe(true);
      }
    });
  });
});
