import type { TereoMcpOptions, ToolDefinition } from "../types.js";
import { describe, expectTypeOf, it } from "vitest";
import { fakeCore } from "./support/fakeCore.js";
import { createTereoMcp } from "../tereoMcp.js";
import pino from "pino";
import { z } from "zod";

// These assertions are checked by `tsc --noEmit`; the calls also run, so a
// definition that compiles is accepted by define at runtime too.
const options: TereoMcpOptions = {
  name: "types",
  version: "1.0.0",
  core: fakeCore(),
  publicUrl: "https://mcp.example.test",
  allowedClients: ["claude"],
  rateLimit: false,
  logger: pino({ level: "silent" }),
};

const base = {
  description: "d",
  permission: null,
  readOnly: true,
} as const;

describe("define typing", () => {
  it("types the handler's input from a static schema", () => {
    const mcp = createTereoMcp(options);
    mcp.define({
      ...base,
      name: "roll",
      input: z.object({ sides: z.number(), label: z.string().optional() }),
      handler: (input) => {
        expectTypeOf(input).toEqualTypeOf<{
          sides: number;
          label?: string | undefined;
        }>();
        // @ts-expect-error the schema has no such field
        void input.nope;
        return input.sides;
      },
    });
  });

  it("gives the handler the schema's output type, not its input type", () => {
    const mcp = createTereoMcp(options);
    mcp.define({
      ...base,
      name: "count",
      input: z.object({ n: z.string().transform((s) => s.length) }),
      handler: (input) => {
        expectTypeOf(input.n).toEqualTypeOf<number>();
        return input.n;
      },
    });
  });

  it("types the input as undefined when there is no input", () => {
    const mcp = createTereoMcp(options);
    mcp.define({
      ...base,
      name: "bare",
      handler: (input, ctx) => {
        expectTypeOf(input).toEqualTypeOf<undefined>();
        return ctx.requestId;
      },
    });
  });

  it("types the input as unknown for a function input, unless annotated", () => {
    const mcp = createTereoMcp(options);
    mcp.define({
      ...base,
      name: "dynamic",
      input: (ctx) =>
        z.object({ id: z.string(), by: z.literal(ctx.auth.userId) }),
      handler: (input) => {
        expectTypeOf(input).toEqualTypeOf<unknown>();
        return "ok";
      },
    });
    mcp.define({
      ...base,
      name: "dynamic_annotated",
      input: async () => z.object({ id: z.string() }),
      handler: (input: { id: string }) => {
        expectTypeOf(input).toEqualTypeOf<{ id: string }>();
        return input.id;
      },
    });
  });

  it("still compiles hand annotations: a type argument, an annotated handler, a ToolDefinition", () => {
    const mcp = createTereoMcp(options);
    mcp.define<{ ms?: number }>({
      ...base,
      name: "typed_arg",
      input: z.object({ ms: z.number().optional() }),
      handler: async ({ ms = 1 }) => ms,
    });
    mcp.define({
      ...base,
      name: "annotated",
      input: z.object({ id: z.string() }),
      handler: (input: { id: string }, ctx) => `${input.id}${ctx.requestId}`,
    });
    const tool: ToolDefinition<{ id: string }> = {
      ...base,
      name: "declared",
      input: z.object({ id: z.string() }),
      handler: (input) => input.id,
    };
    mcp.define(tool);
    const loose: ToolDefinition = { ...base, name: "loose", handler: () => 1 };
    mcp.define(loose);
  });

  it("refuses a handler whose parameter does not match the schema", () => {
    const mcp = createTereoMcp(options);
    mcp.define({
      ...base,
      name: "mismatched",
      input: z.object({ id: z.string() }),
      handler: (input) => {
        // @ts-expect-error id is a string
        const n: number = input.id;
        return n;
      },
    });
  });

  it("checks the handler's return against a static output schema", () => {
    const mcp = createTereoMcp(options);
    const output = z.object({ total: z.number() });
    mcp.define({
      ...base,
      name: "sums",
      input: z.object({ a: z.number(), b: z.number() }),
      output,
      handler: async ({ a, b }) => ({ total: a + b }),
    });
    mcp.define({
      ...base,
      name: "sums_sync",
      output,
      handler: () => ({ total: 1 }),
    });
    mcp.define({
      ...base,
      name: "sums_dynamic",
      input: () => z.object({ a: z.number() }),
      output,
      handler: (input: { a: number }) => ({ total: input.a }),
    });
    mcp.define({
      ...base,
      name: "sums_wrong",
      output,
      // @ts-expect-error total must be a number
      handler: () => ({ total: "one" }),
    });
    mcp.define({
      ...base,
      name: "sums_wrong_dynamic",
      input: () => z.object({ a: z.number() }),
      output,
      // @ts-expect-error total is missing
      handler: (input: { a: number }) => ({ sum: input.a }),
    });
  });
});
