// @module-tag int
// @module-tag files
import { discardScratchFile, scratchDir } from "../../utils/scratchFiles.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createEncryptStream } from "../../utils/encryption.js";
import { encryptBuffer } from "../support/pure/blobCrypto.js";
import { PayloadTooLargeError } from "../../utils/errors.js";
import { blobStore } from "../../utils/blobStore/index.js";
import { PassThrough, Readable } from "stream";
import type { ReadStream } from "fs";
import fs from "fs/promises";
import crypto from "crypto";
import path from "path";
import os from "os";
import {
  assertUnreadBody,
  openBlobRangeStream,
  openBlobStream,
  saveBlobStream,
  stagePart,
} from "../../utils/storage.js";

// Records every file stream storage opens, so a test can see it was closed.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const createReadStream = ((
    ...args: Parameters<typeof actual.createReadStream>
  ) => {
    const stream = actual.createReadStream(...args);
    opened.push(stream);
    return stream;
  }) as typeof actual.createReadStream;
  return {
    ...actual,
    default: { ...actual, createReadStream },
    createReadStream,
  };
});

const opened = vi.hoisted(() => [] as ReadStream[]);

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("openBlobStream", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "blob-stream-"));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("closes the file when the plaintext stream is destroyed unread", async () => {
    const plain = Buffer.from("attachment body");
    const hash = crypto.createHash("sha256").update(plain).digest("hex");
    const { cipher, key } = encryptBuffer(plain, hash);
    const fsPath = path.join(dir, hash);
    await fs.writeFile(fsPath, cipher);

    opened.length = 0;
    const stream = openBlobStream({ fsPath, keyMaterial: key }, hash);
    expect(opened).toHaveLength(1);
    stream.destroy();
    await tick();
    expect(opened[0].destroyed).toBe(true);
  });

  it("closes the file when a range stream is destroyed unread", async () => {
    const { fsPath, key, hash } = await writeBlob("ranged attachment body");

    opened.length = 0;
    const stream = await openBlobRangeStream(
      { fsPath, keyMaterial: key },
      hash,
      2,
      8
    );
    expect(opened).toHaveLength(1);
    stream.destroy();
    await tick();
    expect(opened[0].destroyed).toBe(true);
  });

  async function writeBlob(body: string) {
    const plain = Buffer.from(body);
    const hash = crypto.createHash("sha256").update(plain).digest("hex");
    const { cipher, key } = encryptBuffer(plain, hash);
    const fsPath = path.join(dir, hash);
    await fs.writeFile(fsPath, cipher);
    return { fsPath, key, hash };
  }
});

describe("stagePart", () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("stops reading the body when the part cannot be stored", async () => {
    const failure = Object.assign(new Error("no space left on device"), {
      code: "ENOSPC",
    });
    vi.spyOn(blobStore, "writePart").mockRejectedValueOnce(failure);
    const body = new PassThrough();
    body.write(Buffer.alloc(1024));

    await expect(
      stagePart("upload-1", 1, body, 1024 * 1024, crypto.randomBytes(32))
    ).rejects.toBe(failure);
    await tick();
    expect(body.destroyed).toBe(true);
  });
});

describe("saveBlobStream", () => {
  const scratchNames = async () => {
    try {
      return (await fs.readdir(scratchDir())).sort();
    } catch {
      return [];
    }
  };

  it("refuses a body past the cap and leaves no scratch file", async () => {
    const before = await scratchNames();
    await expect(
      saveBlobStream(Readable.from([Buffer.alloc(10)]), {
        maxBytes: 5,
        tooLarge: () => new PayloadTooLargeError("Upload exceeds max size"),
      })
    ).rejects.toThrow(PayloadTooLargeError);
    expect(await scratchNames()).toEqual(before);
  });

  it("returns the leading plaintext bytes it was asked to sample", async () => {
    const sampled = await saveBlobStream(
      Readable.from([Buffer.from("hello "), Buffer.from("world")]),
      { sniffBytes: 5 }
    );
    const plain = await saveBlobStream(Readable.from([Buffer.from("hello")]));
    try {
      expect(sampled.head.toString()).toBe("hello");
      expect(sampled.sizeBytes).toBe(11);
      expect(plain.head).toHaveLength(0);
    } finally {
      await discardScratchFile(sampled.stagedPath);
      await discardScratchFile(plain.stagedPath);
    }
  });

  it("names its scratch file by kind", async () => {
    const saved = await saveBlobStream(Readable.from([Buffer.from("x")]), {
      kind: "signed-upload",
    });
    try {
      expect(path.basename(saved.stagedPath)).toMatch(/^signed-upload-/);
    } finally {
      await discardScratchFile(saved.stagedPath);
    }
  });
});

describe("openBlobRangeStream and assertUnreadBody", () => {
  describe("range decryption", () => {
    async function collectStream(
      stream: NodeJS.ReadableStream
    ): Promise<Buffer> {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    }

    function sha256(buf: Buffer): string {
      return crypto.createHash("sha256").update(buf).digest("hex");
    }
    it("decrypts any byte range from its offset, as the whole-blob decrypt does", async () => {
      const plain = crypto.randomBytes(1000);
      const hash = sha256(plain);
      const { stream, finalize } = createEncryptStream();
      const cipher = await collectStream(Readable.from([plain]).pipe(stream));
      const key = finalize(hash);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "range-"));
      const fsPath = path.join(dir, "blob");
      await fs.writeFile(fsPath, cipher);
      try {
        for (const [start, end] of [
          [0, 0],
          [0, 15],
          [15, 16],
          [16, 31],
          [17, 500],
          [999, 999],
          [3, 999],
        ]) {
          const out = await collectStream(
            await openBlobRangeStream(
              { fsPath, keyMaterial: key },
              hash,
              start,
              end
            )
          );
          expect([
            start,
            end,
            out.equals(plain.subarray(start, end + 1)),
          ]).toEqual([start, end, true]);
        }
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("refuses a file without the blob header", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "range-"));
      const fsPath = path.join(dir, "blob");
      await fs.writeFile(fsPath, Buffer.alloc(64));
      const plain = Buffer.from("x");
      const { key } = encryptBuffer(plain, sha256(plain));
      try {
        await expect(
          openBlobRangeStream({ fsPath, keyMaterial: key }, sha256(plain), 0, 0)
        ).rejects.toThrow(/magic header/);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("assertUnreadBody", () => {
    it("refuses a body a parser already read", () => {
      const parsed = Object.assign(new PassThrough(), { _body: true });
      expect(() => assertUnreadBody(parsed)).toThrow(/consumed/);
      expect(() => assertUnreadBody(new PassThrough())).not.toThrow();
    });
  });
});
