import type { ObjectForArchiveStream } from "../../utils/db/archives.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { randomBytes } from "crypto";
import { Readable } from "stream";
import { readdirSync } from "fs";
import env from "../../env.js";
import axios from "axios";
import {
  ArchiveAbortedError,
  buildArchiveStream,
} from "../../utils/archiveStream.js";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestBucket,
  createTestFile,
  uploadTestObject,
  cleanupTestEntities,
} from "../support/files.js";

interface CreateArchiveResponse {
  id: string;
  url: string;
  expiresAt: string;
  objectCount: number;
  totalSizeBytes: string;
  format: "zip" | "tar";
  filename: string;
}

async function readArchiveEntries(
  stream: Readable
): Promise<Record<string, Buffer>> {
  // Minimal zip parser — we only need to list central directory entries and
  // extract their local-header payload for the tests. Using `yauzl` or similar
  // would be ideal but we avoid adding a dev dep for one test; instead we
  // accumulate into a Buffer and leverage a tiny inline parser.
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const data = Buffer.concat(chunks);
  const entries: Record<string, Buffer> = {};

  // Locate End Of Central Directory Record (EOCD) — signature 0x06054b50.
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Invalid zip: EOCD not found");

  const totalEntries = data.readUInt16LE(eocd + 10);
  let cdOffset = data.readUInt32LE(eocd + 16);

  for (let i = 0; i < totalEntries; i++) {
    if (data.readUInt32LE(cdOffset) !== 0x02014b50) {
      throw new Error("Invalid zip: central directory entry signature");
    }
    const compressedSize = data.readUInt32LE(cdOffset + 20);
    const nameLen = data.readUInt16LE(cdOffset + 28);
    const extraLen = data.readUInt16LE(cdOffset + 30);
    const commentLen = data.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = data.readUInt32LE(cdOffset + 42);
    const name = data
      .slice(cdOffset + 46, cdOffset + 46 + nameLen)
      .toString("utf8");
    cdOffset += 46 + nameLen + extraLen + commentLen;

    // Walk into the local file header to find the payload offset.
    if (data.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error("Invalid zip: local header signature");
    }
    const lhNameLen = data.readUInt16LE(localHeaderOffset + 26);
    const lhExtraLen = data.readUInt16LE(localHeaderOffset + 28);
    const compressionMethod = data.readUInt16LE(localHeaderOffset + 8);
    const payloadStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    const payload = data.slice(payloadStart, payloadStart + compressedSize);

    if (compressionMethod === 0) {
      // stored
      entries[name] = payload;
    } else if (compressionMethod === 8) {
      // deflated — use zlib.inflateRawSync
      const zlib = await import("zlib");
      entries[name] = zlib.inflateRawSync(payload);
    } else {
      throw new Error(`Unsupported compression method: ${compressionMethod}`);
    }
  }

  return entries;
}

describe("Archive Downloads", () => {
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

  describe("GET /signed/archives/:id", () => {
    it("streams a zip with the expected entries and content-disposition", async () => {
      const createRes = await axios.post<CreateArchiveResponse>(
        `${BASE_URL}/buckets/${testBucket.name}/archives`,
        { prefix: "docs/", filename: "my-docs.zip" },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(createRes.status).toBe(HTTP_STATUS.CREATED);

      const dlRes = await axios.get(createRes.data.url, {
        responseType: "stream",
        validateStatus: () => true,
      });
      expect(dlRes.status).toBe(200);
      expect(dlRes.headers["content-type"]).toBe("application/zip");
      expect(dlRes.headers["content-disposition"]).toContain(
        'filename="my-docs.zip"'
      );

      const entries = await readArchiveEntries(dlRes.data);
      // The prefix "docs/" is dropped so the zip extracts clean.
      expect(Object.keys(entries).sort()).toEqual(
        ["guide.txt", "readme.txt"].sort()
      );
      expect(entries["readme.txt"].toString()).toBe("readme content");
      expect(entries["guide.txt"].toString()).toBe("guide content");
    });

    it("ignores a stripPrefix field and still drops the prefix", async () => {
      const createRes = await axios.post<CreateArchiveResponse>(
        `${BASE_URL}/buckets/${testBucket.name}/archives`,
        { prefix: "docs/", stripPrefix: false },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(createRes.status).toBe(HTTP_STATUS.CREATED);

      const dlRes = await axios.get(createRes.data.url, {
        responseType: "stream",
        validateStatus: () => true,
      });
      expect(dlRes.status).toBe(200);
      const entries = await readArchiveEntries(dlRes.data);
      expect(Object.keys(entries).sort()).toEqual(
        ["guide.txt", "readme.txt"].sort()
      );
    });

    it("rejects a tampered signature", async () => {
      const createRes = await axios.post<CreateArchiveResponse>(
        `${BASE_URL}/buckets/${testBucket.name}/archives`,
        { prefix: "docs/" },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      const url = new URL(createRes.data.url);
      // Flip a middle char of the signature — same trick as presigning.test.ts.
      const sig = url.searchParams.get("sig") ?? "";
      const mid = Math.floor(sig.length / 2);
      const swap = sig[mid] === "A" ? "B" : "A";
      url.searchParams.set(
        "sig",
        sig.slice(0, mid) + swap + sig.slice(mid + 1)
      );
      const dlRes = await axios.get(url.toString(), {
        validateStatus: () => true,
      });
      expect(dlRes.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("answers an id that is not a UUID with 404, not a database error", async () => {
      const res = await axios.get(
        `${BASE_URL}/signed/archives/not-a-uuid?op=archive&expires=1&nonce=n&v=1&sig=s`,
        { validateStatus: () => true }
      );
      expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });
});

describe("Archive stream builder", () => {
  const COUNT = 20;
  // Incompressible, and larger than the archive's buffers: an entry stays
  // open until the archive is read.
  const contents = Array.from({ length: COUNT }, () =>
    randomBytes(192 * 1024).toString("base64")
  );
  let objects: ObjectForArchiveStream[];

  /** Descriptors this process holds open. */
  const openFiles = () => readdirSync("/dev/fd").length;
  const tick = () => new Promise((r) => setTimeout(r, 100));

  beforeAll(async () => {
    const token = await getTestAccessToken();
    const bucket = await createTestBucket(token, { policy: "private" });
    for (let i = 0; i < COUNT; i++) {
      await uploadTestObject(
        token,
        bucket.name,
        `lazy/${i}.txt`,
        createTestFile(contents[i], `${i}.txt`, "text/plain")
      );
    }
    const rows = await prisma.object.findMany({
      where: { bucket: { name: bucket.name }, deletedAt: null },
      select: { id: true },
    });
    objects = await db.archives.loadObjectsForStreaming(rows.map((r) => r.id));
    expect(objects).toHaveLength(COUNT);
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("holds one blob file open at a time, not one per object", async () => {
    const before = openFiles();
    const { stream, finalized } = buildArchiveStream({
      objects,
      format: "zip",
    });
    await tick();
    // Nothing reads the archive yet: only the first entry may be open.
    expect(openFiles() - before).toBeLessThan(3);

    const entries = await readArchiveEntries(stream);
    await finalized;
    expect(Object.keys(entries)).toHaveLength(COUNT);
    expect(entries["lazy/7.txt"].toString()).toBe(contents[7]);
  });

  it("lists a missing or unverifiable blob in MISSING_FILES.txt and carries on", async () => {
    const [first, gone, forged, ...rest] = objects.slice(0, 6);
    const { stream, finalized } = buildArchiveStream({
      objects: [
        first,
        {
          ...gone,
          contentBlob: {
            ...gone.contentBlob,
            fsPath: `${gone.contentBlob.fsPath}.deleted`,
          },
        },
        // Decrypting under another hash fails the GCM tag.
        {
          ...forged,
          contentBlob: { ...forged.contentBlob, hash: "ab".repeat(32) },
        },
        ...rest,
      ],
      format: "zip",
    });

    const entries = await readArchiveEntries(stream);
    await finalized;
    expect(Object.keys(entries).sort()).toEqual(
      [first, ...rest]
        .map((o) => o.objectKey)
        .concat("MISSING_FILES.txt")
        .sort()
    );
    const manifest = entries["MISSING_FILES.txt"].toString();
    expect(manifest).toContain(`${gone.objectKey}\tcontent file is missing`);
    expect(manifest).toContain(forged.objectKey);
    expect(manifest).not.toContain(gone.contentBlob.fsPath);
  });

  it("closes the entry it is reading and rejects when aborted", async () => {
    const before = openFiles();
    const { stream, finalized, abort } = buildArchiveStream({
      objects,
      format: "zip",
    });
    stream.on("error", () => {});
    await new Promise((resolve) => stream.once("data", resolve));
    abort();

    await expect(finalized).rejects.toBeInstanceOf(ArchiveAbortedError);
    await tick();
    expect(openFiles()).toBeLessThanOrEqual(before);
  });
});
