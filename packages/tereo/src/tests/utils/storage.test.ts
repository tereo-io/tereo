// @module-tag int
// @module-tag files
import { openBlobRangeStream, openBlobStream } from "../../utils/storage.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { encryptBuffer } from "../support/pure/blobCrypto.js";
import type { ReadStream } from "fs";
import fs from "fs/promises";
import crypto from "crypto";
import path from "path";
import os from "os";

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
