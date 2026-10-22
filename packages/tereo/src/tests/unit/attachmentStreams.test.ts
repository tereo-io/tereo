import { openBlobRangeStream, openBlobStream } from "../../utils/storage.js";
import { emailAdapter } from "../../utils/notifications/channels/email.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { encryptBuffer } from "../support/pure/blobCrypto.js";
import { PassThrough, type Readable } from "stream";
import type { ReadStream } from "fs";
import { createServer } from "net";
import env from "../../env.js";
import fs from "fs/promises";
import crypto from "crypto";
import path from "path";
import os from "os";

const opened = vi.hoisted(() => [] as ReadStream[]);

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

describe("email send", () => {
  const allowPrivateHosts = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;

  afterAll(() => {
    env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = allowPrivateHosts;
  });

  /** A localhost port nothing listens on. */
  const closedPort = async () => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const { port } = server.address() as { port: number };
    await new Promise((resolve) => server.close(resolve));
    return port;
  };

  it("destroys every opened attachment stream when the send fails", async () => {
    env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = true;
    const streams: Readable[] = [];
    const attachment = (filename: string) => ({
      filename,
      contentType: "text/plain",
      size: 4,
      async open() {
        const s = new PassThrough();
        streams.push(s);
        return s;
      },
    });

    await expect(
      emailAdapter.send({
        deliveryId: crypto.randomUUID(),
        connection: {
          id: crypto.randomUUID(),
          slug: "down",
          channel: "email",
          settings: {
            host: "127.0.0.1",
            port: await closedPort(),
            security: "none",
            defaultFrom: { address: "billing@acme.com" },
            allowedSenders: ["@acme.com"],
          },
        },
        secrets: {},
        content: { subject: "Hi", text: "x" },
        recipients: [
          { address: "a@example.com", userId: null, options: { as: "to" } },
        ],
        attachments: [attachment("a.txt"), attachment("b.txt")],
      })
    ).rejects.toThrow();

    expect(streams).toHaveLength(2);
    expect(streams.every((s) => s.destroyed)).toBe(true);
  });
});
