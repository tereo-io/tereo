// @module-tag int
// @module-tag files
import type { ObjectForArchiveStream } from "../../utils/db/archives.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { randomBytes } from "crypto";
import { Readable } from "stream";
import { readdirSync } from "fs";
import {
  ArchiveAbortedError,
  buildArchiveStream,
} from "../../utils/archiveStream.js";
import {
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "../support/files.js";

describe("buildArchiveStream", () => {
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
