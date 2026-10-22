// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import { Readable } from "stream";
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
  waitFor,
} from "../../../../../../support/files.js";

describe("GET and HEAD /v1/files/signed/archives/:id", () => {
  describe("signed URLs", () => {
    const anyStatus = { validateStatus: () => true, maxRedirects: 0 };

    // The access log is written after the response is sent.
    const waitForAccessLog = async (where: Record<string, unknown>) => {
      let row: Awaited<ReturnType<typeof prisma.accessLog.findFirst>> = null;
      await waitFor(async () => {
        row = await prisma.accessLog.findFirst({
          where,
          orderBy: { timestamp: "desc" },
        });
        return row !== null;
      }, 5000);
      return row!;
    };
    let admin: string;
    let bucket: { id: number; name: string };
    const auth = (token: string) => ({
      headers: { Authorization: `Bearer ${token}` },
      ...anyStatus,
    });

    beforeAll(async () => {
      admin = await getTestAccessToken();
      bucket = await createTestBucket(admin, { policy: "private" });
      await uploadTestObjectAndGetId(
        admin,
        bucket.name,
        "docs/report.pdf",
        createTestFile("pdf-bytes", "report.pdf", "application/pdf")
      );
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    const createShare = async (
      body: Record<string, unknown>,
      token: string = admin
    ) => {
      const res = await axios.post<{ id: string; token: string; url: string }>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        body,
        auth(token)
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      return res.data;
    };

    const signedUrlFor = async (shareUrl: string) => {
      const redirect = await axios.get(shareUrl, anyStatus);
      expect(redirect.status).toBe(302);
      return redirect.headers["location"] as string;
    };

    const createArchive = async (token: string) => {
      const res = await axios.post<{ id: string; url: string }>(
        `${BASE_URL}/buckets/${bucket.name}/archives`,
        { prefix: "docs/" },
        auth(token)
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      return res.data;
    };

    describe("HEAD", () => {
      it("probes a capped archive share's URL without spending it", async () => {
        const share = await createShare({
          kind: "ARCHIVE",
          prefix: "docs/",
          maxDownloads: 1,
        });
        const url = await signedUrlFor(share.url);

        const head = await axios.head(url, anyStatus);
        expect(head.status).toBe(HTTP_STATUS.OK);
        expect(head.headers["content-type"]).toBe("application/zip");
        expect(head.headers["content-disposition"]).toMatch(/^attachment/);

        expect((await axios.get(url, anyStatus)).status).toBe(HTTP_STATUS.OK);
        expect((await axios.get(url, anyStatus)).status).toBe(
          HTTP_STATUS.FORBIDDEN
        );
      });
    });

    describe("archive ids", () => {
      const probe = (id: string) =>
        axios.get(
          `${BASE_URL}/signed/archives/${id}?op=archive&expires=${
            Math.floor(Date.now() / 1000) + 60
          }&nonce=abc&v=1&sig=bogus`,
          anyStatus
        );

      it("answers a missing and an existing archive alike before the signature verifies", async () => {
        const archive = await createArchive(admin);
        const existing = await probe(archive.id);
        const missing = await probe(randomUUID());
        expect(existing.status).toBe(HTTP_STATUS.FORBIDDEN);
        expect(missing.status).toBe(HTTP_STATUS.FORBIDDEN);
        expect(missing.data).toEqual(existing.data);
      });
    });

    describe("access logs", () => {
      it("records an archive download", async () => {
        const archive = await createArchive(admin);
        const res = await axios.get(archive.url, anyStatus);
        expect(res.status).toBe(HTTP_STATUS.OK);
        const row = await waitForAccessLog({
          requestId: res.headers["x-request-id"],
        });
        expect(row).toMatchObject({
          bucketId: bucket.id,
          operation: "ARCHIVE_DOWNLOAD",
          statusCode: 200,
        });
      });
    });
  });

  describe("Archive Downloads", () => {
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
      for (
        let i = data.length - 22;
        i >= Math.max(0, data.length - 65557);
        i--
      ) {
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
          throw new Error(
            `Unsupported compression method: ${compressionMethod}`
          );
        }
      }

      return entries;
    }
    let testToken: string;
    let testBucket: { id: number; name: string; policy: string };

    beforeAll(async () => {
      testToken = await getTestAccessToken();
      testBucket = await createTestBucket(testToken, { policy: "private" });

      // Layout under one prefix for prefix-mode tests.
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
    });

    afterAll(async () => {
      await cleanupTestEntities();
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
});
