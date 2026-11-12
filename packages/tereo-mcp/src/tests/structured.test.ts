import type { TereoMcpOptions, ToolDefinition } from "../types.js";
import { serve as serveWith, tool } from "./support/serve.js";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "./support/connect.js";
import { ToolError } from "../errors.js";
import { z } from "zod";

const token = "test-token-u1|client=claude|perms=";

const INTERNAL_ERROR =
  /^Internal error \(request [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

const serve = (extra: Partial<TereoMcpOptions>, ...tools: ToolDefinition[]) =>
  serveWith(cleanups, extra, ...tools);

const output = z.object({ total: z.number(), label: z.string() });

// Every test lists first: a schema the SDK cannot convert fails tools/list.
const connectListed = async (url: string, era: "legacy" | "modern") => {
  const client = await connect(url, token, { era });
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("report");
  return client;
};

describe.each(["legacy", "modern"] as const)(
  "structured results over the served endpoint (%s era)",
  (era) => {
    it("lists the output schema as JSON Schema", async () => {
      const { server } = await serve(
        {},
        tool("report", () => ({ total: 1, label: "a" }), { output }),
        tool("plain", () => "text")
      );
      const client = await connect(server.url, token, { era });

      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

      expect(byName.report.outputSchema).toMatchObject({
        type: "object",
        properties: { total: { type: "number" }, label: { type: "string" } },
        required: ["total", "label"],
      });
      expect(byName.plain.outputSchema).toBeUndefined();
      await client.close();
    });

    it("returns structuredContent and the same value as JSON text", async () => {
      const { server } = await serve(
        {},
        tool("report", () => ({ total: 3, label: "three", extra: true }), {
          output,
        })
      );
      const client = await connectListed(server.url, era);

      const result = await client.callTool({ name: "report" });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ total: 3, label: "three" });
      expect(result.content).toEqual([
        { type: "text", text: '{"total":3,"label":"three"}' },
      ]);
      await client.close();
    });

    it.each([
      ["a mismatching return", () => ({ total: "SECRET-VALUE", label: 9 })],
      ["a schema that does not re-validate its own output", undefined],
    ])(
      "answers %s with the internal error and leaks no values",
      async (_label, handler) => {
        const { server, raw } = await serve(
          {},
          handler
            ? tool("report", handler, { output })
            : // Each parse appends "x", so a second parse breaks maxLength.
              tool("report", () => ({ n: "SECRET-VALUE".slice(0, 3) }), {
                output: z.object({
                  n: z
                    .string()
                    .overwrite((v) => `${v}x`)
                    .max(4),
                }),
              })
        );
        const client = await connectListed(server.url, era);

        const result = await client.callTool({ name: "report" });

        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          { type: "text", text: expect.stringMatching(INTERNAL_ERROR) },
        ]);
        expect(result.structuredContent).toBeUndefined();
        const seen = JSON.stringify(result) + raw.join("");
        expect(seen).not.toContain("SECRET-VALUE");
        expect(seen).not.toContain("SECx");
        expect(seen).not.toContain("Output validation error");
        await client.close();
      }
    );

    it("names a record's key as * in the log and sends neither to the client", async () => {
      const { server, raw, lines } = await serve(
        {},
        tool("report", () => ({ scores: { "SECRET-KEY": "x" } }), {
          output: z.object({ scores: z.record(z.string(), z.number()) }),
        })
      );
      const client = await connectListed(server.url, era);

      const result = await client.callTool({ name: "report" });

      expect(result.content).toEqual([
        { type: "text", text: expect.stringMatching(INTERNAL_ERROR) },
      ]);
      expect(JSON.stringify(result)).not.toContain("SECRET-KEY");
      expect(raw.join("")).not.toContain("SECRET-KEY");
      const line = lines.find((l) => l.msg === "MCP tool call");
      expect((line?.err as { message: string }).message).toContain(
        "scores.* (invalid_type)"
      );
      await client.close();
    });

    it("turns an over-size structured result into the size error, without structuredContent", async () => {
      const { server } = await serve(
        { maxResultBytes: 10 },
        tool("report", () => ({ total: 1, label: "long label" }), { output })
      );
      const client = await connectListed(server.url, era);

      const result = await client.callTool({ name: "report" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "Result too large (32 bytes; limit 10)" },
      ]);
      expect(result.structuredContent).toBeUndefined();
      await client.close();
    });

    it("answers a ToolError from a tool with output as a plain tool error", async () => {
      const { server } = await serve(
        {},
        tool(
          "report",
          () => {
            throw new ToolError("No such report");
          },
          { output }
        )
      );
      const client = await connectListed(server.url, era);

      const result = await client.callTool({ name: "report" });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "No such report" },
      ]);
      expect(result.structuredContent).toBeUndefined();
      await client.close();
    });
  }
);
