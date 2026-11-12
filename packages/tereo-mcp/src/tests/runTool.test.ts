import type { ToolContext, ToolDefinition } from "../types.js";
import type { AuthContext, CoreClient } from "@tereo-io/sdk";
import { ForbiddenError, HttpError } from "@tereo-io/sdk";
import { describe, expect, it, vi } from "vitest";
import { ToolError } from "../errors.js";
import { runTool } from "../runTool.js";
import type { Logger } from "pino";
import pino from "pino";

const setup = (
  handler: ToolDefinition["handler"],
  toolExtra: Partial<ToolDefinition> = {}
) => {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: "debug" },
    { write: (s: string) => lines.push(JSON.parse(s)) }
  ) as Logger;
  const ctx: ToolContext = {
    auth: {
      userId: "user-1",
      clientId: "client-1",
      organizationId: "org-1",
    } as unknown as AuthContext,
    core: {} as CoreClient,
    requestId: "req-9",
    logger,
    signal: new AbortController().signal,
  };
  const tool: ToolDefinition = {
    name: "do_thing",
    description: "d",
    permission: null,
    readOnly: true,
    handler,
    ...toolExtra,
  };
  const run = (
    input: unknown = {},
    extra: {
      limiter?: Parameters<typeof runTool>[0]["limiter"];
      max?: number;
      timeoutMs?: number;
      closing?: AbortSignal;
      requestSignal?: AbortSignal;
    } = {}
  ) =>
    runTool(
      {
        tool,
        ctx,
        limiter: extra.limiter ?? null,
        maxResultBytes: extra.max ?? 1000,
        timeoutMs: extra.timeoutMs ?? 60_000,
        closing: extra.closing,
        logger,
      },
      input,
      extra.requestSignal
    );
  return { run, lines };
};

describe("runTool", () => {
  it("returns a string result as is", async () => {
    const { run, lines } = setup(() => "hello");
    expect(await run()).toEqual({ content: [{ type: "text", text: "hello" }] });
    expect(lines[0]).toMatchObject({
      level: 30,
      msg: "MCP tool call",
      tool: "do_thing",
      user_id: "user-1",
      client_id: "client-1",
      org_id: "org-1",
      request_id: "req-9",
      outcome: "ok",
    });
    expect(Number.isInteger(lines[0].duration_ms)).toBe(true);
  });

  it("stringifies an object and maps undefined to an empty string", async () => {
    expect((await setup(() => ({ a: 1 })).run()).content[0].text).toBe(
      '{"a":1}'
    );
    expect((await setup(() => undefined).run()).content[0].text).toBe("");
  });

  it("reports a ToolError's message", async () => {
    const { run, lines } = setup(() => {
      throw new ToolError("No such connection");
    });
    expect(await run()).toEqual({
      isError: true,
      content: [{ type: "text", text: "No such connection" }],
    });
    expect(lines[0]).toMatchObject({ level: 30, outcome: "tool_error" });
  });

  it("reports a 4xx SDK error's message", async () => {
    const { run, lines } = setup(() => {
      throw new ForbiddenError("nope");
    });
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("nope");
    expect(lines[0]).toMatchObject({ outcome: "tool_error" });
  });

  it.each([
    [
      "a 500 HttpError",
      () => new HttpError(500, "boom", "pg: relation missing"),
    ],
    ["a plain Error", () => new Error("pg: relation missing")],
  ])("hides %s behind a request id", async (_n, make) => {
    const { run, lines } = setup(() => {
      throw make();
    });
    const result = await run();
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Internal error (request req-9)" }],
    });
    expect(JSON.stringify(result)).not.toContain("relation missing");
    expect(lines[0]).toMatchObject({ level: 50, outcome: "internal_error" });
    expect((lines[0].err as { message: string }).message).toBe(
      "pg: relation missing"
    );
  });

  it("treats a non-serialisable result as an internal error", async () => {
    const { run, lines } = setup(() => ({ n: 1n }));
    const result = await run();
    expect(result.content[0].text).toBe("Internal error (request req-9)");
    expect(result.isError).toBe(true);
    expect(lines[0]).toMatchObject({ level: 50, outcome: "internal_error" });
  });

  it("refuses a result over the byte limit, measured in utf-8 bytes", async () => {
    const { run, lines } = setup(() => "é".repeat(10));
    const result = await run({}, { max: 15 });
    expect(result).toEqual({
      isError: true,
      content: [
        { type: "text", text: "Result too large (20 bytes; limit 15)" },
      ],
    });
    expect(lines[0]).toMatchObject({ level: 30, outcome: "tool_error" });
  });

  it("refuses without calling the handler when rate limited", async () => {
    const handler = vi.fn(() => "x");
    const { run, lines } = setup(handler);
    const result = await run(
      {},
      {
        limiter: async () => ({ allowed: false, retryAfterSeconds: 12 }),
      }
    );
    expect(result).toEqual({
      isError: true,
      content: [
        { type: "text", text: "Rate limit reached; retry in 12 seconds" },
      ],
    });
    expect(handler).not.toHaveBeenCalled();
    expect(lines[0]).toMatchObject({ level: 30, outcome: "rate_limited" });
  });

  it("never logs the input or the result", async () => {
    const { run, lines } = setup(() => "SECRET-RESULT");
    await run({ q: "SECRET-INPUT" });
    const raw = JSON.stringify(lines);
    expect(raw).not.toContain("SECRET-INPUT");
    expect(raw).not.toContain("SECRET-RESULT");
  });
});

describe("runTool timeouts and the abort signal", () => {
  const never = () => new Promise<never>(() => undefined);
  const signalOf = (seen: { ctx?: ToolContext }) => {
    if (!seen.ctx) throw new Error("handler did not run");
    return seen.ctx.signal;
  };

  it("returns a timeout error at the timeout for a handler that never settles, and logs it at warn", async () => {
    const { run, lines } = setup(never);

    const started = Date.now();
    const result = await run({}, { timeoutMs: 30 });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Tool timed out after 30 ms" }],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 40,
      msg: "MCP tool call",
      outcome: "timeout",
    });
  });

  it("aborts ctx.signal at the timeout with a TimeoutError reason", async () => {
    const seen: { ctx?: ToolContext } = {};
    const { run } = setup((_input, ctx) => {
      seen.ctx = ctx;
      return never();
    });

    await run({}, { timeoutMs: 20 });

    const signal = signalOf(seen);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe("TimeoutError");
  });

  it("discards a rejection after the timeout: no unhandled rejection and no second line", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { run, lines } = setup(
        () =>
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error("late failure")), 60)
          )
      );

      const result = await run({}, { timeoutMs: 10 });
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(result.content[0].text).toBe("Tool timed out after 10 ms");
      expect(unhandled).toEqual([]);
      expect(lines).toHaveLength(1);
      expect(lines.some((line) => (line.level as number) >= 50)).toBe(false);
      expect(JSON.stringify(lines)).not.toContain("late failure");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("discards a result that arrives after the timeout", async () => {
    const { run, lines } = setup(
      () => new Promise((resolve) => setTimeout(() => resolve("late"), 40))
    );

    const result = await run({}, { timeoutMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(result.content[0].text).toBe("Tool timed out after 10 ms");
    expect(lines).toHaveLength(1);
  });

  it("leaves a fast handler alone and never aborts its signal", async () => {
    const seen: { ctx?: ToolContext } = {};
    const { run, lines } = setup((_input, ctx) => {
      seen.ctx = ctx;
      return "quick";
    });

    const result = await run({}, { timeoutMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(result).toEqual({ content: [{ type: "text", text: "quick" }] });
    expect(signalOf(seen).aborted).toBe(false);
    expect(lines[0]).toMatchObject({ level: 30, outcome: "ok" });
  });

  it("keeps the rate-limit count of a call that timed out", async () => {
    const limiter = vi.fn(async () => ({ allowed: true as const }));
    const { run } = setup(never);

    const result = await run({}, { timeoutMs: 10, limiter });

    expect(result.content[0].text).toBe("Tool timed out after 10 ms");
    expect(limiter).toHaveBeenCalledTimes(1);
  });

  it.each(["closing", "requestSignal"] as const)(
    "aborts ctx.signal when the %s signal aborts",
    async (which) => {
      const outer = new AbortController();
      const seen: { ctx?: ToolContext } = {};
      const { run } = setup(
        (_input, ctx) =>
          new Promise((resolve) => {
            seen.ctx = ctx;
            ctx.signal.addEventListener("abort", () => resolve("stopped"));
            outer.abort(new Error(`${which} reason`));
          })
      );

      const result = await run({}, { timeoutMs: 5_000, [which]: outer.signal });

      expect(result.content[0].text).toBe("stopped");
      expect(signalOf(seen).aborted).toBe(true);
      expect((signalOf(seen).reason as Error).message).toBe(`${which} reason`);
    }
  );

  it("starts a call with an aborted signal when the server is already closing", async () => {
    const outer = new AbortController();
    outer.abort(new Error("closing"));
    const seen: { ctx?: ToolContext } = {};
    const { run } = setup((_input, ctx) => {
      seen.ctx = ctx;
      return "ran";
    });

    await run({}, { closing: outer.signal });

    expect(signalOf(seen).aborted).toBe(true);
  });
});
