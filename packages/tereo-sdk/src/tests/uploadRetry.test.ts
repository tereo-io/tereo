import { createServer, type IncomingMessage, type Server } from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { uploadObject } from "../requests/files/objects/index.js";
import { createHandler, resetHandler } from "../handler.js";
import type { AddressInfo } from "net";

vi.mock("@dianemo/backend-redis", async () => {
  const { memoryBackend } = await import("@dianemo/core");
  return { redisBackend: () => memoryBackend() };
});

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

// Core stand-in: the token endpoint, and an upload route whose first attempt
// fails as `failFirst` says.
let failFirst: "503" | "reset" = "503";
let uploads: Buffer[] = [];
let server: Server;
let handler: ReturnType<typeof createHandler>;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/oauth/token") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          access_token: "t",
          token_type: "Bearer",
          expires_in: 3600,
        })
      );
      return;
    }
    uploads.push(body);
    if (uploads.length === 1) {
      if (failFirst === "reset") {
        req.socket.destroy();
        return;
      }
      res.statusCode = 503;
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: "o" }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  handler = createHandler({
    url: `http://127.0.0.1:${port}`,
    clientId: "c",
    clientSecret: "s",
    requestHandlerKey: "k".repeat(48),
    redis: {} as never,
  });
  await handler.start();
});

afterAll(async () => {
  await handler.stop();
  resetHandler();
  await new Promise((resolve) => server.close(resolve));
});

describe("uploadObject retries", () => {
  const file = Buffer.from("the whole file, sent on every attempt");

  it.each(["503", "reset"] as const)(
    "resend the full body after a %s",
    async (failure) => {
      failFirst = failure;
      uploads = [];
      await expect(uploadObject("b", "k", { file })).resolves.toEqual({
        id: "o",
      });
      expect(uploads).toHaveLength(2);
      expect(uploads[1].includes(file)).toBe(true);
      expect(uploads[1].equals(uploads[0])).toBe(true);
    },
    10_000
  );
});
