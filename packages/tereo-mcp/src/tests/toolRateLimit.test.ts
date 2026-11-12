import type { TereoMcpOptions, ToolDefinition } from "../types.js";
import { serve as serveWith, tool } from "./support/serve.js";
import { afterEach, describe, expect, it } from "vitest";
import { fakeRedis } from "./support/fakeRedis.js";
import { connect } from "./support/connect.js";

const token = "test-token-u1|client=claude|perms=";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

const serve = (extra: Partial<TereoMcpOptions>, ...tools: ToolDefinition[]) =>
  serveWith(cleanups, extra, ...tools);

const limited = [
  { type: "text", text: "Rate limit reached; retry in 42 seconds" },
];

describe("per-tool rate limits over the served endpoint", () => {
  it("counts a tool's own limit apart from the server-wide one, and exempts a tool", async () => {
    const redis = fakeRedis();
    const { server, lines } = await serve(
      { redis, rateLimit: { perMinute: 1 } },
      tool("own", () => "own", { rateLimit: { perMinute: 2 } }),
      tool("shared", () => "shared"),
      tool("free", () => "free", { rateLimit: false })
    );
    const client = await connect(server.url, token);
    const call = (name: string) => client.callTool({ name });

    expect((await call("shared")).content).toEqual([
      { type: "text", text: "shared" },
    ]);
    expect((await call("shared")).content).toEqual(limited);
    expect((await call("own")).content).toEqual([
      { type: "text", text: "own" },
    ]);
    expect((await call("own")).content).toEqual([
      { type: "text", text: "own" },
    ]);
    expect((await call("own")).content).toEqual(limited);
    for (let i = 0; i < 3; i++) {
      expect((await call("free")).content).toEqual([
        { type: "text", text: "free" },
      ]);
    }

    expect(Object.fromEntries(redis.counts)).toEqual({
      "@tereo-io/mcp:quotes:rl:u1": 2,
      "@tereo-io/mcp:quotes:rl:u1:own": 3,
    });
    expect(
      lines
        .filter(
          (l) => l.msg === "MCP tool call" && l.outcome === "rate_limited"
        )
        .map((l) => l.tool)
    ).toEqual(["shared", "own"]);
    await client.close();
  });
});
