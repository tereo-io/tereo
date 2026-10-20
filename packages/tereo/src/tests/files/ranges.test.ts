import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
  uploadTestObject,
} from "./utils/test-helpers.js";

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

describe("Range downloads", () => {
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

  it("serves ranges of a version by id", async () => {
    const versioned = await createTestBucket(token);
    await axios.put(
      `${BASE_URL}/buckets/${versioned.name}`,
      { versioningEnabled: true },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const obj = await uploadTestObject(
      token,
      versioned.name,
      "v.bin",
      binary(content)
    );
    const version = await prisma.objectVersion.findFirstOrThrow({
      where: { objectId: obj.id, isCurrent: true },
    });
    const res = await get(
      `${BASE_URL}/buckets/${versioned.name}/objects/by-id/${obj.id}/versions/${version.id}/download`,
      { Range: "bytes=50-59" }
    );
    expect(res.status).toBe(206);
    expect(body(res)).toEqual(content.subarray(50, 60));
  });

  it("serves ranges through a signed URL and a share", async () => {
    const presign = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/presign`,
      { operation: "read", expiresInSeconds: 300 },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const signed = await get(presign.data.url, { Range: "bytes=1-2" }, false);
    expect(signed.status).toBe(206);
    expect(body(signed)).toEqual(content.subarray(1, 3));

    const share = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/shares`,
      { kind: "OBJECT", objectId },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const shared = await get(share.data.url, { Range: "bytes=-3" }, false);
    expect(shared.status).toBe(206);
    expect(body(shared)).toEqual(content.subarray(97));
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
