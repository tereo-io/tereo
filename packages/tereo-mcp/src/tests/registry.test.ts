import type { ToolDefinition } from "../types.js";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../registry.js";
import { ToolError } from "../errors.js";
import { z } from "zod";

const tool = (overrides: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name: "list_things",
  description: "Lists things",
  permission: null,
  readOnly: true,
  handler: () => ({}),
  ...overrides,
});

describe("ToolRegistry", () => {
  it("lists tools in definition order", () => {
    const registry = new ToolRegistry();
    registry.define(tool({ name: "b" }));
    registry.define(tool({ name: "a" }));
    registry.define(tool({ name: "c_1" }));
    expect(registry.list().map((t) => t.name)).toEqual(["b", "a", "c_1"]);
  });

  it.each(["Bad", "has-dash", "has space", ""])(
    "rejects the name %j",
    (name) => {
      expect(() => new ToolRegistry().define(tool({ name }))).toThrow(
        /\^\[a-z0-9_\]\+\$/
      );
    }
  );

  it("rejects a duplicate name and names it", () => {
    const registry = new ToolRegistry();
    registry.define(tool());
    expect(() => registry.define(tool())).toThrow(/list_things/);
  });

  it("rejects an empty description", () => {
    expect(() => new ToolRegistry().define(tool({ description: "" }))).toThrow(
      /description/
    );
  });

  it("rejects an undefined permission but accepts null and a string", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.define(
        tool({ permission: undefined as unknown as string | null })
      )
    ).toThrow(/permission/);
    registry.define(tool({ name: "open", permission: null }));
    registry.define(tool({ name: "gated", permission: "things:read" }));
    expect(registry.list()).toHaveLength(2);
  });

  it("rejects an empty-string permission", () => {
    expect(() => new ToolRegistry().define(tool({ permission: "" }))).toThrow(
      /permission/
    );
  });

  it("rejects a readOnly that is not a boolean", () => {
    expect(() =>
      new ToolRegistry().define(tool({ readOnly: "yes" as unknown as boolean }))
    ).toThrow(/readOnly/);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects timeoutMs %s", (timeoutMs) => {
    expect(() => new ToolRegistry().define(tool({ timeoutMs }))).toThrow(
      /"list_things".*timeoutMs/
    );
  });

  it("accepts a positive integer timeoutMs", () => {
    const registry = new ToolRegistry();
    registry.define(tool({ timeoutMs: 1 }));
    expect(registry.list()).toHaveLength(1);
  });

  it.each([
    ["a function", () => z.object({})],
    ["a plain object", { total: "number" }],
    ["a non-object schema", z.string()],
  ])("rejects an output that is %s", (_label, output) => {
    expect(() =>
      new ToolRegistry().define(
        tool({ output: output as unknown as z.ZodObject })
      )
    ).toThrow(/"list_things".*output/);
  });

  it("rejects any define after freeze", () => {
    const registry = new ToolRegistry();
    registry.define(tool());
    registry.freeze();
    expect(() => registry.define(tool({ name: "other" }))).toThrow(
      "Tools cannot be defined after the server has started"
    );
    expect(registry.list()).toHaveLength(1);
  });
});

describe("ToolError", () => {
  it("is an Error carrying its message", () => {
    const err = new ToolError("nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("nope");
    expect(err.name).toBe("ToolError");
  });
});
