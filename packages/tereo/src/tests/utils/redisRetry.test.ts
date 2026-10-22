// @module-tag int
// @module-tag platform
// @module-tag redis-outage
import { createServer, connect, type Server, type Socket } from "node:net";
import { redisRetryStrategy } from "../../utils/redisRetry.js";
import { describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import env from "../../env.js";

describe("redisRetryStrategy", () => {
  it("never gives up, backing off to a 5s cap", () => {
    expect(redisRetryStrategy(1)).toBe(200);
    expect(redisRetryStrategy(10)).toBe(2000);
    expect(redisRetryStrategy(25)).toBe(5000);
    expect(redisRetryStrategy(10_000)).toBe(5000);
  });

  // A TCP proxy in front of the test Redis stands in for an outage: closing
  // it refuses connections until it listens again on the same port.
  it("reconnects after an outage longer than a few retries", async () => {
    const target = new URL(env.REDIS_URL!);
    const sockets = new Set<Socket>();
    const listen = (port: number) =>
      new Promise<Server>((resolve) => {
        const proxy = createServer((client) => {
          const upstream = connect(
            Number(target.port || 6379),
            target.hostname
          );
          sockets.add(client).add(upstream);
          client.pipe(upstream).pipe(client);
          const drop = () => {
            client.destroy();
            upstream.destroy();
          };
          client.on("error", drop).on("close", drop);
          upstream.on("error", drop).on("close", drop);
        });
        proxy.listen(port, "127.0.0.1", () => resolve(proxy));
      });
    const stop = (proxy: Server) =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        proxy.close(() => resolve());
      });

    let proxy = await listen(0);
    const port = (proxy.address() as { port: number }).port;
    const client = new Redis({
      host: "127.0.0.1",
      port,
      maxRetriesPerRequest: null,
      retryStrategy: (times) => redisRetryStrategy(times),
    });
    client.on("error", () => undefined);
    // quit() must still end the connection rather than trigger a retry.
    const ended = new Promise<void>((resolve) =>
      client.once("end", () => resolve())
    );
    try {
      expect(await client.ping()).toBe("PONG");

      await stop(proxy);
      // Longer than the old strategy's whole budget (200+400+600ms).
      await new Promise((r) => setTimeout(r, 2500));
      expect(client.status).not.toBe("end");

      proxy = await listen(port);
      expect(await client.ping()).toBe("PONG");
    } finally {
      await client.quit().catch(() => client.disconnect());
      await stop(proxy);
    }
    await ended;
    expect(client.status).toBe("end");
  }, 20_000);
});
