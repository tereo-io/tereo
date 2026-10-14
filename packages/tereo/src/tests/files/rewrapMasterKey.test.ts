import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setMasterKey } from "../../utils/masterKeys.js";
import { BASE_URL } from "./utils/test-helpers.js";
import { prisma } from "../../utils/db/prisma.js";
import FormData from "form-data";
import env from "../../env.js";
import crypto from "crypto";
import axios from "axios";
import {
  parseRewrapArgs,
  rewrapMasterKey,
  RewrapUsageError,
} from "../../cli/rewrapMasterKey/index.js";
import {
  aadForBlobHash,
  generateDek,
  wrapDek,
} from "../../utils/encryption.js";
import {
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
  testIdempotencyKey,
} from "./utils/test-helpers.js";

/**
 * Integration tests for the rewrap-master-key CLI. The single-master-key test
 * env can't exercise the actual re-wrap path (there's no other version to
 * rotate to), so these tests pin the safety properties: idempotent skip on
 * already-current rows, and no DB damage on a real run.
 */
describe("rewrap-master-key", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("skips every row when all are already at the active master key", async () => {
    const bucket = await createTestBucket(token, { policy: "private" });

    // Create one blob via a real upload so the row's wrapped DEK is valid.
    const form = new FormData();
    const payload = Buffer.from("rewrap probe");
    form.append("file", payload, { filename: "probe.txt" });
    const upload = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}/objects/probe.txt`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": testIdempotencyKey(),
        },
        validateStatus: () => true,
      }
    );
    expect(upload.status).toBe(201);

    const before = await prisma.contentBlob.findFirst({
      orderBy: { createdAt: "desc" },
    });
    expect(before).not.toBeNull();

    const result = await rewrapMasterKey({});
    // Active key version matches every row's master_key_version, so all rows
    // skip; nothing is rewrapped.
    expect(result.blobs.rewrapped).toBe(0);
    expect(result.blobs.skipped).toBeGreaterThanOrEqual(1);
    expect(result.multipartUploads.rewrapped).toBe(0);

    // Confirm the wrapped DEK is byte-identical — skip path mustn't touch the row.
    const after = await prisma.contentBlob.findUnique({
      where: { hash: before!.hash },
    });
    expect(Buffer.from(after!.wrappedDek)).toStrictEqual(
      Buffer.from(before!.wrappedDek)
    );
    expect(after!.masterKeyVersion).toBe(before!.masterKeyVersion);
  });

  it("dry-run reports counts without writing", async () => {
    const result = await rewrapMasterKey({ dryRun: true });
    // Even in dry-run mode the scanned counts reflect the walk; rewrapped count
    // is 0 here because everything is already at the target version.
    // The first test uploaded at least one blob.
    expect(result.blobs.scanned).toBeGreaterThanOrEqual(1);
    expect(result.blobs.rewrapped).toBe(0);
  });

  it("supports cursor resume via fromHash", async () => {
    const bucket = await createTestBucket(token, { policy: "private" });
    const form = new FormData();
    form.append("file", Buffer.from(`second probe ${testIdempotencyKey()}`), {
      filename: "second.txt",
    });
    const upload = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}/objects/second.txt`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": testIdempotencyKey(),
        },
        validateStatus: () => true,
      }
    );
    expect(upload.status).toBe(201);

    const all = await prisma.contentBlob.findMany({
      orderBy: { hash: "asc" },
      select: { hash: true },
    });
    expect(all.length).toBeGreaterThanOrEqual(2);

    const result = await rewrapMasterKey({
      fromHash: all[0].hash,
      pageSize: 50,
    });
    // Walk excludes the seed hash, so scanned ≤ remaining count. Bound check
    // is one-sided; the precise count depends on parallel test inserts.
    expect(result.blobs.scanned).toBeLessThanOrEqual(all.length - 1);
  });

  it("counts a row only when its compare-and-set update applies", async () => {
    // A row under a retired key version, fed to the walk directly: the test
    // env has one master key, so no stored row can need a rewrap.
    const oldVersion = env.FILE_SERVICE_ACTIVE_MASTER_KEY_VERSION + 1000;
    setMasterKey(oldVersion, crypto.randomBytes(32).toString("base64"));
    const hashes = [
      crypto.randomBytes(32).toString("hex"),
      crypto.randomBytes(32).toString("hex"),
    ];
    const rows = hashes.map((hash) => ({
      hash,
      masterKeyVersion: oldVersion,
      wrappedDek: wrapDek(generateDek(), oldVersion, aadForBlobHash(hash)),
    }));
    const findBlobs = vi
      .spyOn(prisma.contentBlob, "findMany")
      .mockResolvedValueOnce(rows as never)
      .mockResolvedValue([] as never);
    const findUploads = vi
      .spyOn(prisma.multipartUpload, "findMany")
      .mockResolvedValue([] as never);
    // The first row applies; the second was rewrapped by someone else since
    // it was read, so its update matches nothing.
    const execute = vi
      .spyOn(prisma, "$executeRaw")
      .mockResolvedValueOnce(1 as never)
      .mockResolvedValueOnce(0 as never);
    try {
      const result = await rewrapMasterKey({});
      expect(execute).toHaveBeenCalledTimes(2);
      expect(result.blobs).toEqual({
        scanned: 2,
        rewrapped: 1,
        skipped: 1,
        failed: 0,
      });
    } finally {
      findBlobs.mockRestore();
      findUploads.mockRestore();
      execute.mockRestore();
    }
  });

  it("logs and counts a DEK it can't unwrap, and rewraps the rest", async () => {
    const oldVersion = env.FILE_SERVICE_ACTIVE_MASTER_KEY_VERSION + 1001;
    setMasterKey(oldVersion, crypto.randomBytes(32).toString("base64"));
    const [corrupt, good] = [0, 1].map(() =>
      crypto.randomBytes(32).toString("hex")
    );
    const rows = [
      // Wrapped for another row: the AAD check refuses it.
      {
        hash: corrupt,
        masterKeyVersion: oldVersion,
        wrappedDek: wrapDek(generateDek(), oldVersion, aadForBlobHash(good)),
      },
      {
        hash: good,
        masterKeyVersion: oldVersion,
        wrappedDek: wrapDek(generateDek(), oldVersion, aadForBlobHash(good)),
      },
    ];
    const findBlobs = vi
      .spyOn(prisma.contentBlob, "findMany")
      .mockResolvedValueOnce(rows as never)
      .mockResolvedValue([] as never);
    const findUploads = vi
      .spyOn(prisma.multipartUpload, "findMany")
      .mockResolvedValue([] as never);
    const execute = vi
      .spyOn(prisma, "$executeRaw")
      .mockResolvedValue(1 as never);
    try {
      const result = await rewrapMasterKey({});
      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.blobs).toEqual({
        scanned: 2,
        rewrapped: 1,
        skipped: 0,
        failed: 1,
      });
    } finally {
      findBlobs.mockRestore();
      findUploads.mockRestore();
      execute.mockRestore();
    }
  });

  describe("argument parsing", () => {
    it("parses every option", () => {
      const upload = "0190f0e0-0000-7000-8000-000000000001";
      expect(
        parseRewrapArgs([
          "--dry-run",
          "--from-hash",
          "ab12",
          "--from-upload",
          upload,
          "--limit",
          "5",
          "--page-size",
          "50",
        ])
      ).toEqual({
        dryRun: true,
        fromHash: "ab12",
        fromUpload: upload,
        limit: 5,
        pageSize: 50,
      });
    });

    it.each([
      [["--limit", "abc"]],
      [["--limit", "0"]],
      [["--limit", "-1"]],
      [["--limit", "1.5"]],
      [["--page-size", "0"]],
      [["--page-size"]],
      [["--from-hash"]],
      [["--from-hash", "--dry-run"]],
      [["--from-hash", "not-hex"]],
      [["--from-upload", "nope"]],
      [["--dryrun"]],
      [["extra"]],
    ])("refuses %j", (argv) => {
      expect(() => parseRewrapArgs(argv)).toThrow(RewrapUsageError);
    });
  });
});
