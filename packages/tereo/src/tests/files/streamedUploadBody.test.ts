import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertUnreadBody } from "../../utils/storage.js";
import { PassThrough } from "stream";
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
} from "./utils/test-helpers.js";

// A body whose Content-Type a JSON or form parser would match must still be
// stored byte for byte by the streamed upload routes.
const BODIES = [
  { contentType: "application/json", body: '{"hello":"world"}' },
  { contentType: "application/x-www-form-urlencoded", body: "a=1&b=2" },
];

describe("streamed uploads with a parseable Content-Type", () => {
  let token: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  const download = async (bucket: string, key: string) => {
    const res = await axios.get<ArrayBuffer>(
      `${BASE_URL}/buckets/${bucket}/objects/${key}`,
      { headers: auth(), responseType: "arraybuffer" }
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
    return Buffer.from(res.data).toString();
  };

  it.each(BODIES)(
    "stores a presigned PUT's bytes ($contentType)",
    async ({ contentType, body }) => {
      const bucket = await createTestBucket(token);
      const original = await uploadTestObject(
        token,
        bucket.name,
        "doc.json",
        createTestFile("first", "doc.json", "text/plain")
      );
      const presign = await axios.post<{ url: string }>(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${original.id}/presign`,
        { operation: "write", expiresInSeconds: 60 },
        { headers: auth() }
      );

      const put = await axios.put(presign.data.url, body, {
        headers: { "Content-Type": contentType },
        transformRequest: (data) => data,
        validateStatus: () => true,
      });
      expect([HTTP_STATUS.OK, HTTP_STATUS.CREATED]).toContain(put.status);
      expect(await download(bucket.name, "doc.json")).toBe(body);
    }
  );

  it.each(BODIES)(
    "stores a multipart part's bytes ($contentType)",
    async ({ contentType, body }) => {
      const bucket = await createTestBucket(token);
      const init = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/multipart`,
        { objectKey: "parts.bin", contentType: "application/octet-stream" },
        { headers: auth() }
      );
      expect(init.status).toBe(HTTP_STATUS.CREATED);
      const uploadId = init.data.uploadId as string;

      const part = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/parts/1`,
        body,
        {
          headers: { ...auth(), "Content-Type": contentType },
          transformRequest: (data) => data,
        }
      );
      expect(part.status).toBe(HTTP_STATUS.OK);
      expect(part.data.sizeBytes).toBe(String(Buffer.byteLength(body)));

      const complete = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/complete`,
        { parts: [{ partNumber: 1, etag: part.data.etag }] },
        { headers: { ...auth(), "Idempotency-Key": testIdempotencyKey() } }
      );
      expect([HTTP_STATUS.OK, HTTP_STATUS.CREATED]).toContain(complete.status);
      expect(await download(bucket.name, "parts.bin")).toBe(body);
    }
  );
});

describe("assertUnreadBody", () => {
  it("refuses a body a parser already read", () => {
    const parsed = Object.assign(new PassThrough(), { _body: true });
    expect(() => assertUnreadBody(parsed)).toThrow(/consumed/);
    expect(() => assertUnreadBody(new PassThrough())).not.toThrow();
  });
});
