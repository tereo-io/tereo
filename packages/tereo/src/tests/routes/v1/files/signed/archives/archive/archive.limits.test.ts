// @module-tag int
// @module-tag files
// @module-tag security
import { downloadArchiveViaSignedUrl } from "../../../../../../../routes/v1/files/signed/archives/archive/controllers.js";
import { verifiedReadBudget } from "../../../../../../../utils/storage.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import env from "../../../../../../../env.js";
import type { AddressInfo } from "net";
import { randomBytes } from "crypto";
import type { Server } from "http";
import express from "express";
import axios from "axios";
import http from "http";
import net from "net";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
  waitFor,
} from "../../../../../../support/files.js";

// The controller on a server of this process's own, where the send timeout
// can be a second: the suite's server keeps the default.
describe("GET /v1/files/signed/archives/:id", () => {
  describe("a client that stops reading", () => {
    const sendTimeout = env.FILE_SERVICE_VERIFIED_SEND_TIMEOUT_SECONDS;
    const COUNT = 5;
    const ENTRY_BYTES = 8 * 1024 * 1024;
    let server: Server;
    let port: number;
    let token: string;
    let bucket: { name: string };

    /** The path and query of a fresh signed URL for the archive. */
    const archivePath = async () => {
      const res = await axios.post<{ url: string }>(
        `${BASE_URL}/buckets/${bucket.name}/archives`,
        { prefix: "big/" },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      const url = new URL(res.data.url);
      return `${url.pathname}${url.search}`;
    };

    beforeAll(async () => {
      env.FILE_SERVICE_VERIFIED_SEND_TIMEOUT_SECONDS = 1;
      token = await getTestAccessToken();
      bucket = await createTestBucket(token);
      // Base64 of random bytes deflates to about three quarters: still more
      // than the sockets between client and server buffer, so a client that
      // stops reading stalls the archive.
      for (let i = 0; i < COUNT; i++) {
        const body = `entry ${i}\n${randomBytes(ENTRY_BYTES).toString("base64")}`;
        await uploadTestObject(
          token,
          bucket.name,
          `big/${i}.txt`,
          createTestFile(body.slice(0, ENTRY_BYTES), `${i}.txt`, "text/plain")
        );
      }

      const app = express();
      app.get("/v1/files/signed/archives/:id", downloadArchiveViaSignedUrl);
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      env.FILE_SERVICE_VERIFIED_SEND_TIMEOUT_SECONDS = sendTimeout;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await cleanupTestEntities();
    });

    it("is given up on once it has taken no bytes for the send timeout", async () => {
      const path = await archivePath();
      const socket = net.connect(port, "127.0.0.1");
      socket.pause();
      let closed = false;
      socket.on("close", () => (closed = true));
      socket.on("error", () => {});
      let abandoned = false;
      server.once("request", (_req, res) => {
        res.once("close", () => (abandoned = !res.writableFinished));
      });
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`);

      await waitFor(async () => abandoned, 5000);
      expect(verifiedReadBudget.used).toBe(0);
      // The server reset the connection; the client learns of it once it reads.
      socket.resume();
      await waitFor(async () => closed, 5000);
      expect(closed).toBe(true);
      expect(socket.bytesRead).toBeLessThan((COUNT * ENTRY_BYTES) / 2);
    });

    it("is served the whole archive when it reads slowly for longer than the send timeout", async () => {
      const path = await archivePath();
      const started = Date.now();
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path }, resolve)
          .on("error", reject);
      });
      expect(res.statusCode).toBe(HTTP_STATUS.OK);

      let received = 0;
      let sinceRest = 0;
      for await (const chunk of res) {
        received += (chunk as Buffer).length;
        sinceRest += (chunk as Buffer).length;
        // About 10 MiB a second: slow, but never idle for the timeout.
        if (sinceRest >= 1024 * 1024) {
          sinceRest = 0;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      expect(res.complete).toBe(true);
      expect(received).toBeGreaterThan((COUNT * ENTRY_BYTES) / 2);
      expect(Date.now() - started).toBeGreaterThan(
        2 * env.FILE_SERVICE_VERIFIED_SEND_TIMEOUT_SECONDS * 1000
      );
    });
  });
});
