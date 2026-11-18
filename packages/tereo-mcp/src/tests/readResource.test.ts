import type { ResourceDefinition, ToolContext } from "../types.js";
import { describe, expect, it, vi } from "vitest";
import { readResource } from "../readResource.js";
import { fakeCore } from "./support/fakeCore.js";
import { untilAborted } from "../signals.js";
import type { Logger } from "pino";
import pino from "pino";

const capture = () => {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: "debug" },
    { write: (s: string) => void lines.push(JSON.parse(s)) }
  ) as Logger;
  return { lines, logger };
};

const read = (
  resource: Partial<ResourceDefinition>,
  logger: Logger,
  signals: { closing?: AbortSignal; request?: AbortSignal } = {}
) =>
  readResource(
    {
      resource: {
        uri: "ui://app/card.html",
        name: "card",
        mimeType: "text/html",
        read: () => ({ text: "hi" }),
        ...resource,
      },
      ctx: {
        auth: { userId: "u1" } as ToolContext["auth"],
        core: fakeCore(),
        requestId: "r1",
        logger,
        signal: new AbortController().signal,
      },
      limiter: null,
      maxResultBytes: 1_000,
      timeoutMs: 1_000,
      closing: signals.closing,
      logger,
    },
    signals.request
  );

describe("readResource", () => {
  it("logs a cancelled read at info, not as a failure", async () => {
    const { lines, logger } = capture();
    const request = new AbortController();
    const pending = read(
      {
        read: (ctx) =>
          new Promise<never>((_resolve, reject) =>
            ctx.signal.addEventListener("abort", () =>
              reject(ctx.signal.reason)
            )
          ),
      },
      logger,
      { request: request.signal }
    );
    request.abort();

    await expect(pending).rejects.toThrow("The resource could not be read");
    expect(lines.map((l) => [l.level, l.msg])).toEqual([
      [30, "MCP resource read cancelled"],
    ]);
  });

  it("does not start a read once the server is closing", async () => {
    const { lines, logger } = capture();
    const closing = new AbortController();
    closing.abort();
    const reader = vi.fn(() => ({ text: "hi" }));

    await expect(
      read({ read: reader }, logger, { closing: closing.signal })
    ).rejects.toThrow("The resource could not be read");
    expect(reader).not.toHaveBeenCalled();
    expect(lines.map((l) => l.msg)).toEqual(["MCP resource read cancelled"]);
  });

  it("returns a blob as given", async () => {
    const { logger } = capture();
    const result = await read({ read: () => ({ blob: "aGk=" }) }, logger);
    expect(result.contents).toEqual([
      { uri: "ui://app/card.html", mimeType: "text/html", blob: "aGk=" },
    ]);
  });
});

describe("untilAborted", () => {
  it("does not start work under an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("closing"));
    const work = vi.fn(async () => {
      throw new Error("would be unhandled");
    });

    await expect(untilAborted(work, controller.signal)).rejects.toThrow(
      "closing"
    );
    expect(work).not.toHaveBeenCalled();
  });

  it("observes work that rejects after the signal has aborted", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const controller = new AbortController();
    let fail!: (err: Error) => void;
    const work = () =>
      new Promise<never>((_resolve, reject) => (fail = reject));

    const pending = untilAborted(work, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("timed out"));
    await expect(pending).rejects.toThrow("timed out");
    fail(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
