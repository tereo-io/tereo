import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  BASE_URL,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "./utils/test-helpers.js";

const tarEntries = (buf: Buffer): Record<string, string> => {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const name = buf
      .subarray(offset, offset + 100)
      .toString("utf8")
      .replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(
      buf
        .subarray(offset + 124, offset + 136)
        .toString("utf8")
        .replace(/\0.*$/s, "")
        .trim(),
      8
    );
    out[name] = buf
      .subarray(offset + 512, offset + 512 + size)
      .toString("utf8");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
};

describe("archive snapshots", () => {
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

  const createArchive = async (
    bucketName: string,
    body: { keys: string[] } | { prefix: string }
  ) => {
    const created = await axios.post<{ url: string; objectCount: number }>(
      `${BASE_URL}/buckets/${bucketName}/archives`,
      { ...body, format: "tar" },
      auth()
    );
    expect(created.status).toBe(201);
    return created.data;
  };

  const download = (url: string) =>
    axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      validateStatus: () => true,
    });

  const upload = (bucketName: string, key: string, content: string) =>
    uploadTestObject(token, bucketName, key, createTestFile(content));

  it("leaves out an entry overwritten after creation and serves the rest as archived", async () => {
    const bucket = await createTestBucket(token);
    const a = `a ${randomUUID()}`;
    const b = `b ${randomUUID()}`;
    await upload(bucket.name, "snap/a.txt", a);
    await upload(bucket.name, "snap/b.txt", b);
    const archive = await createArchive(bucket.name, {
      keys: ["snap/a.txt", "snap/b.txt"],
    });

    await upload(
      bucket.name,
      "snap/a.txt",
      `written after the archive ${randomUUID()} `.repeat(50)
    );

    const res = await download(archive.url);
    expect(res.status).toBe(200);
    expect(tarEntries(Buffer.from(res.data))).toEqual({ "snap/b.txt": b });
  });

  it("leaves out an entry whose object was overwritten in a versioned bucket", async () => {
    const bucket = await createTestBucket(token);
    await axios.put(
      `${BASE_URL}/buckets/${bucket.name}`,
      { versioningEnabled: true },
      auth()
    );
    const b = `b ${randomUUID()}`;
    await upload(bucket.name, "a.txt", `a ${randomUUID()}`);
    await upload(bucket.name, "b.txt", b);
    const archive = await createArchive(bucket.name, {
      keys: ["a.txt", "b.txt"],
    });

    await upload(bucket.name, "a.txt", `later ${randomUUID()}`);

    const res = await download(archive.url);
    expect(res.status).toBe(200);
    expect(tarEntries(Buffer.from(res.data))).toEqual({ "b.txt": b });
  });

  it("does not add objects uploaded under the prefix after creation", async () => {
    const bucket = await createTestBucket(token);
    const a = `a ${randomUUID()}`;
    await upload(bucket.name, "dir/a.txt", a);
    const archive = await createArchive(bucket.name, { prefix: "dir/" });

    await upload(bucket.name, "dir/new.txt", `new ${randomUUID()}`);

    const res = await download(archive.url);
    expect(res.status).toBe(200);
    expect(tarEntries(Buffer.from(res.data))).toEqual({ "a.txt": a });
  });

  it("answers 410 when no entry still has its archived content", async () => {
    const bucket = await createTestBucket(token);
    const a = await upload(bucket.name, "a.txt", `a ${randomUUID()}`);
    await upload(bucket.name, "b.txt", `b ${randomUUID()}`);
    const archive = await createArchive(bucket.name, {
      keys: ["a.txt", "b.txt"],
    });

    await upload(bucket.name, "b.txt", `later ${randomUUID()}`);
    const del = await axios.delete(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${a.id}`,
      auth()
    );
    expect(del.status).toBe(204);

    const res = await download(archive.url);
    expect(res.status).toBe(410);
    expect(JSON.parse(Buffer.from(res.data).toString("utf8")).error).toBe(
      "archive_gone"
    );
  });
});
