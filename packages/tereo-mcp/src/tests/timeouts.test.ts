import type { TereoMcpOptions, ToolContext, ToolDefinition } from "../types.js";
import { serve as serveWith, tool } from "./support/serve.js";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "./support/connect.js";

const token = "test-token-u1|client=claude|perms=";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

const serve = (extra: Partial<TereoMcpOptions>, ...tools: ToolDefinition[]) =>
  serveWith(cleanups, extra, ...tools);

const never = () => new Promise<never>(() => undefined);
const sleep = (ms: number) =>
  new Promise<string>((resolve) => setTimeout(() => resolve("done"), ms));

describe("tool timeouts over the served endpoint", () => {
  it("answers the client with the timeout text", async () => {
    const { server, lines } = await serve(
      { toolTimeoutMs: 50 },
      tool("hang", never)
    );
    const client = await connect(server.url, token);

    const result = await client.callTool({ name: "hang" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Tool timed out after 50 ms" },
    ]);
    expect(lines.find((l) => l.msg === "MCP tool call")).toMatchObject({
      level: 40,
      outcome: "timeout",
    });
    await client.close();
  });

  it("lets a tool's timeoutMs override toolTimeoutMs, both ways", async () => {
    const { server } = await serve(
      { toolTimeoutMs: 50 },
      tool("longer", () => sleep(150), { timeoutMs: 5_000 }),
      tool("shorter", () => sleep(150), { timeoutMs: 20 }),
      tool("defaulted", () => sleep(150))
    );
    const client = await connect(server.url, token);

    const longer = await client.callTool({ name: "longer" });
    const shorter = await client.callTool({ name: "shorter" });
    const defaulted = await client.callTool({ name: "defaulted" });

    expect(longer.content).toEqual([{ type: "text", text: "done" }]);
    expect(shorter.content).toEqual([
      { type: "text", text: "Tool timed out after 20 ms" },
    ]);
    expect(defaulted.content).toEqual([
      { type: "text", text: "Tool timed out after 50 ms" },
    ]);
    await client.close();
  });

  it("aborts the signal of an in-flight call when close() begins", async () => {
    let entered!: (ctx: ToolContext) => void;
    const inHandler = new Promise<ToolContext>(
      (resolve) => (entered = resolve)
    );
    const { server } = await serve(
      {},
      tool(
        "until_closed",
        (_input, ctx) =>
          new Promise((resolve) => {
            entered(ctx);
            ctx.signal.addEventListener("abort", () => resolve("stopped"));
          })
      )
    );
    const client = await connect(server.url, token);

    const call = client.callTool({ name: "until_closed" });
    const ctx = await inHandler;
    expect(ctx.signal.aborted).toBe(false);
    const closing = server.close();
    const result = await call;
    await closing;

    expect(ctx.signal.aborted).toBe(true);
    expect((ctx.signal.reason as Error).name).toBe("AbortError");
    expect(result.content).toEqual([{ type: "text", text: "stopped" }]);
    await client.close().catch(() => undefined);
  });

  it("logs a call whose handler rejects with the abort at close() as cancelled", async () => {
    let entered!: () => void;
    const inHandler = new Promise<void>((resolve) => (entered = resolve));
    const { server, lines } = await serve(
      {},
      tool(
        "until_closed",
        (_input, ctx) =>
          new Promise((_resolve, reject) => {
            entered();
            ctx.signal.addEventListener("abort", () =>
              reject(ctx.signal.reason)
            );
          })
      )
    );
    const client = await connect(server.url, token);

    const call = client.callTool({ name: "until_closed" });
    await inHandler;
    const closing = server.close();
    const result = await call;
    await closing;

    expect(result.content).toEqual([
      { type: "text", text: "Tool call cancelled" },
    ]);
    const line = lines.find((l) => l.msg === "MCP tool call");
    expect(line).toMatchObject({ level: 30, outcome: "cancelled" });
    expect(line).not.toHaveProperty("err");
    await client.close().catch(() => undefined);
  });

  it.each(["legacy", "modern"] as const)(
    "logs a call whose handler rejects with the abort on disconnect as cancelled (%s era)",
    async (era) => {
      let entered!: () => void;
      const inHandler = new Promise<void>((resolve) => (entered = resolve));
      const { server, lines } = await serve(
        {},
        tool(
          "until_gone",
          (_input, ctx) =>
            new Promise((_resolve, reject) => {
              entered();
              ctx.signal.addEventListener("abort", () =>
                reject(ctx.signal.reason)
              );
            })
        )
      );
      const client = await connect(server.url, token, { era });

      void client.callTool({ name: "until_gone" }).catch(() => undefined);
      await inHandler;
      await client.close();
      await new Promise((resolve) => setTimeout(resolve, 200));

      const line = lines.find((l) => l.msg === "MCP tool call");
      expect(line).toMatchObject({ level: 30, outcome: "cancelled" });
      expect(line).not.toHaveProperty("err");
    }
  );

  it.each(["legacy", "modern"] as const)(
    "close() after a mid-call disconnect resolves promptly (%s era)",
    async (era) => {
      let entered!: () => void;
      const inHandler = new Promise<void>((resolve) => (entered = resolve));
      const { server } = await serve(
        {},
        tool(
          "until_gone",
          (_input, ctx) =>
            new Promise((resolve) => {
              entered();
              ctx.signal.addEventListener("abort", () => resolve("gone"));
            })
        )
      );
      const client = await connect(server.url, token, { era });

      void client.callTool({ name: "until_gone" }).catch(() => undefined);
      await inHandler;
      await client.close();
      // The client opens one more connection after close and sends nothing on it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const started = Date.now();
      await server.close();

      expect(Date.now() - started).toBeLessThan(1_500);
    }
  );

  it.each(["legacy", "modern"] as const)(
    "aborts the signal when the client disconnects mid-call (%s era)",
    async (era) => {
      let entered!: (ctx: ToolContext) => void;
      const inHandler = new Promise<ToolContext>(
        (resolve) => (entered = resolve)
      );
      const { server } = await serve(
        {},
        tool(
          "until_gone",
          (_input, ctx) =>
            new Promise((resolve) => {
              entered(ctx);
              ctx.signal.addEventListener("abort", () => resolve("gone"));
            })
        )
      );
      const client = await connect(server.url, token, { era });

      void client.callTool({ name: "until_gone" }).catch(() => undefined);
      const ctx = await inHandler;
      expect(ctx.signal.aborted).toBe(false);
      await client.close();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(ctx.signal.aborted).toBe(true);
    }
  );
});
