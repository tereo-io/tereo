import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import FormData from "form-data";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  testIdempotencyKey,
  uploadTestObject,
} from "../support/files.js";

const put = (
  token: string,
  bucketName: string,
  key: string,
  content: string,
  headers: Record<string, string> = {},
  contentType = "text/plain"
) => {
  const form = new FormData();
  form.append("file", Buffer.from(content), {
    filename: "file.txt",
    contentType,
  });
  return axios.put(`${BASE_URL}/buckets/${bucketName}/objects/${key}`, form, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": testIdempotencyKey(),
      ...form.getHeaders(),
      ...headers,
    },
    validateStatus: () => true,
  });
};

describe("Conditional writes and download caching", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("If-None-Match: * on upload", () => {
    it("replays a retried create under the same Idempotency-Key", async () => {
      const bucket = await createTestBucket(token);
      const key = testIdempotencyKey();
      const body = `once ${randomUUID()}`;
      const headers = { "If-None-Match": "*", "Idempotency-Key": key };

      const first = await put(token, bucket.name, "once.txt", body, headers);
      expect(first.status).toBe(HTTP_STATUS.CREATED);

      const retry = await put(token, bucket.name, "once.txt", body, headers);
      expect(retry.status).toBe(HTTP_STATUS.CREATED);
      expect(retry.headers["idempotency-replay"]).toBe("true");
      expect(retry.data.id).toBe(first.data.id);

      const other = await put(token, bucket.name, "once.txt", body, {
        "If-None-Match": "*",
      });
      expect(other.status).toBe(412);
      expect(other.data.error).toBe("precondition_failed");
    });

    it("lets exactly one of several concurrent creates win", async () => {
      const bucket = await createTestBucket(token);
      const results = await Promise.all(
        ["one", "two", "three"]
          .map((n) => `${n} ${randomUUID()}`)
          .map((content) =>
            put(token, bucket.name, "race.txt", content, {
              "If-None-Match": "*",
            })
          )
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === HTTP_STATUS.CREATED)).toHaveLength(1);
      expect(statuses.filter((s) => s === 412)).toHaveLength(2);
    });
  });

  describe("If-Match on upload", () => {
    it("replaces only when the ETag matches", async () => {
      const bucket = await createTestBucket(token);
      const first = await uploadTestObject(
        token,
        bucket.name,
        "doc.txt",
        createTestFile(`v1 ${randomUUID()}`)
      );

      const stale = await put(
        token,
        bucket.name,
        "doc.txt",
        `v2 ${randomUUID()}`,
        {
          "If-Match": '"0123456789abcdef0123456789abcdef"',
        }
      );
      expect(stale.status).toBe(412);

      const fresh = await put(
        token,
        bucket.name,
        "doc.txt",
        `v2 ${randomUUID()}`,
        {
          "If-Match": `"${first.etag}"`,
        }
      );
      expect(fresh.status).toBe(HTTP_STATUS.OK);

      const missing = await put(
        token,
        bucket.name,
        "nope.txt",
        `v1 ${randomUUID()}`,
        {
          "If-Match": "*",
        }
      );
      expect(missing.status).toBe(412);
    });
  });

  it("refuses a content type longer than the column holds", async () => {
    const bucket = await createTestBucket(token);
    const res = await put(
      token,
      bucket.name,
      "long.txt",
      "text",
      {},
      `text/${"a".repeat(300)}`
    );
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.data.error).toBe("invalid_content_type");
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

    it("marks a private bucket's version download private", async () => {
      const bucket = await createTestBucket(token, { policy: "private" });
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
      const base = `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${object.id}/versions`;
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const versions = await axios.get(base, auth);
      const versionId = versions.data.data[0].versionId;
      const res = await axios.get(`${base}/${versionId}/download`, auth);
      expect(res.headers["cache-control"]).toBe(
        "private, max-age=31536000, immutable"
      );
    });
  });
});
