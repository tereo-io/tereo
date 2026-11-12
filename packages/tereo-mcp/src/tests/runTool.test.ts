import type { ToolContext, ToolDefinition } from "../types.js";
import type { AuthContext, CoreClient } from "@tereo-io/sdk";
import { ForbiddenError, HttpError } from "@tereo-io/sdk";
import { describe, expect, it, vi } from "vitest";
import { ToolError } from "../errors.js";
import { runTool } from "../runTool.js";
import type { Logger } from "pino";
import pino from "pino";

const setup = (handler: ToolDefinition["handler"]) => {
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
  };
  const tool: ToolDefinition = {
    name: "do_thing",
    description: "d",
    permission: null,
    readOnly: true,
    handler,
  };
  const run = (
    input: unknown = {},
    extra: {
      limiter?: Parameters<typeof runTool>[0]["limiter"];
      max?: number;
    } = {}
  ) =>
    runTool(
      {
        tool,
        ctx,
        limiter: extra.limiter ?? null,
        maxResultBytes: extra.max ?? 1000,
        logger,
      },
      input
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
