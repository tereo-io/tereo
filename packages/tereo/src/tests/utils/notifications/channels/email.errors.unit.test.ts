// @module-tag unit
// @module-tag notifications
import { emailAdapter } from "../../../../utils/notifications/channels/email.js";
import { describe, it, expect, afterAll } from "vitest";
import { PassThrough, type Readable } from "stream";
import env from "../../../../env.js";
import { createServer } from "net";
import crypto from "crypto";

describe("emailAdapter", () => {
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
