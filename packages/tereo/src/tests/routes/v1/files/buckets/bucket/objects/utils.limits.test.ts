// @module-tag int
// @module-tag files
// @module-tag security
import { sendBlobBody } from "../../../../../../../routes/v1/files/buckets/bucket/objects/utils.js";
import { encryptBuffer } from "../../../../../../support/pure/blobCrypto.js";
import { verifiedReadBudget } from "../../../../../../../utils/storage.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "../../../../../../support/files.js";
import env from "../../../../../../../env.js";
import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import fs from "fs/promises";
import crypto from "crypto";
import path from "path";
import net from "net";
import os from "os";

describe("sendBlobBody", () => {
  const sendTimeout = env.FILE_SERVICE_VERIFIED_SEND_TIMEOUT_SECONDS;
  const plain = crypto.randomBytes(8 * 1024 * 1024);
  let dir: string;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    env.FILE_SERVICE_VERIFIED_SEND_TIMEOUT_SECONDS = 1;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "send-blob-"));
    const hash = crypto.createHash("sha256").update(plain).digest("hex");
    const { cipher, key } = encryptBuffer(plain, hash);
    const fsPath = path.join(dir, hash);
    await fs.writeFile(fsPath, cipher);

    const app = express();
    app.get("/blob", (req, res, next) => {
      sendBlobBody(
        req,
        res,
        { hash, fsPath, sizeBytes: BigInt(plain.length), ...key },
        { etag: "etag" }
      ).catch(next);
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    env.FILE_SERVICE_VERIFIED_SEND_TIMEOUT_SECONDS = sendTimeout;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("gives up on a reader that stops reading, and returns its bytes to the budget", async () => {
    const socket = net.connect(port, "127.0.0.1");
    socket.pause();
    let closed = false;
    socket.on("close", () => (closed = true));
    socket.on("error", () => {});
    socket.write("GET /blob HTTP/1.1\r\nHost: localhost\r\n\r\n");

    await waitFor(async () => verifiedReadBudget.used > 0, 5000);
    expect(verifiedReadBudget.used).toBe(plain.length);

    await waitFor(async () => verifiedReadBudget.used === 0, 5000);
    // The server reset the connection; the client learns of it once it reads.
    socket.resume();
    await waitFor(async () => closed, 5000);
    expect(socket.bytesRead).toBeLessThan(plain.length);
  });

  it("holds the budget only until a reader that keeps reading has the body", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/blob`);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(plain)).toBe(true);
    await waitFor(async () => verifiedReadBudget.used === 0, 5000);
  });

  it("charges a range of a verified blob for the range alone once it is verified", async () => {
    const socket = net.connect(port, "127.0.0.1");
    socket.pause();
    socket.on("error", () => {});
    socket.write(
      "GET /blob HTTP/1.1\r\nHost: localhost\r\nRange: bytes=0-6291455\r\n\r\n"
    );
    try {
      await waitFor(
        async () => verifiedReadBudget.used === 6 * 1024 * 1024,
        5000
      );
    } finally {
      socket.destroy();
    }
    await waitFor(async () => verifiedReadBudget.used === 0, 5000);
  });
});
