import { createServer, connect, type Socket } from "node:net";
import env from "../../env.js";

export const withinMs = <T>(promise: Promise<T>, ms: number, label: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} still pending`)), ms)
    ),
  ]);

/**
 * A TCP proxy in front of the test Redis. `cut()` stands in for an outage:
 * it drops every connection, and every reconnect from then on, counting them
 * in `attempts`.
 */
export const startRedisProxy = async () => {
  const target = new URL(env.REDIS_URL!);
  const sockets = new Set<Socket>();
  let down = false;
  const state = { attempts: 0 };
  const proxy = createServer((client) => {
    if (down) {
      state.attempts++;
      client.destroy();
      return;
    }
    const upstream = connect(Number(target.port || 6379), target.hostname);
    sockets.add(client).add(upstream);
    client.pipe(upstream).pipe(client);
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", drop).on("close", drop);
    upstream.on("error", drop).on("close", drop);
  });
  await new Promise<void>((resolve) =>
    proxy.listen(0, "127.0.0.1", () => resolve())
  );
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String((proxy.address() as { port: number }).port);

  const cut = () => {
    down = true;
    for (const s of sockets) s.destroy();
  };
  const close = () =>
    new Promise<void>((resolve) => proxy.close(() => resolve()));
  return { url: url.toString(), cut, close, state };
};
