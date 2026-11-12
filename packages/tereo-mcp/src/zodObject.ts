import type { z } from "zod";

// Structural, so a schema from another copy of zod still counts.
export const isZodObject = (value: unknown): value is z.ZodObject =>
  typeof value === "object" &&
  value !== null &&
  (value as { _zod?: { def?: { type?: unknown } } })._zod?.def?.type ===
    "object";

// Converted the way the MCP SDK lists a tool; a schema that fails here would
// fail tools/list for every caller who can see the tool.
export const toJsonSchemaError = (
  schema: unknown,
  io: "input" | "output"
): unknown => {
  try {
    const std = (
      schema as {
        "~standard"?: {
          jsonSchema?: Record<string, (o: { target: string }) => unknown>;
        };
      }
    )["~standard"];
    const convert = std?.jsonSchema?.[io];
    if (!convert) return new Error("The schema has no JSON Schema converter");
    convert({ target: "draft-2020-12" });
    return undefined;
  } catch (err) {
    return err;
  }
};

interface Def {
  type?: string;
  shape?: Record<string, unknown>;
  element?: unknown;
  items?: unknown[];
  rest?: unknown;
  innerType?: unknown;
  in?: unknown;
  getter?: () => unknown;
  options?: unknown[];
}

const defOf = (schema: unknown): Def | undefined =>
  (schema as { _zod?: { def?: Def } } | undefined)?._zod?.def;

const WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "catch",
  "readonly",
  "nonoptional",
]);

const unwrap = (schema: unknown): Def | undefined => {
  let current = schema;
  for (let depth = 0; depth < 32; depth++) {
    const def = defOf(current);
    if (!def) return undefined;
    if (def.type && WRAPPERS.has(def.type)) current = def.innerType;
    else if (def.type === "pipe") current = def.in;
    else if (def.type === "lazy" && def.getter) current = def.getter();
    else return def;
  }
  return undefined;
};

const shapeWith = (def: Def | undefined, key: string): unknown => {
  if (def?.type === "object" && def.shape && Object.hasOwn(def.shape, key)) {
    return def.shape[key];
  }
  if (def?.type === "union") {
    for (const option of def.options ?? []) {
      const found = shapeWith(unwrap(option), key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

// A segment is named only when the schema declares it; record, catchall and
// map keys come from the value being validated, so they become "*".
export const describePath = (
  schema: unknown,
  path: readonly PropertyKey[]
): string => {
  let current: unknown = schema;
  const parts = path.map((segment) => {
    const def = unwrap(current);
    if (typeof segment === "number" && def?.type === "array") {
      current = def.element;
      return String(segment);
    }
    if (typeof segment === "number" && def?.type === "tuple") {
      current = def.items?.[segment] ?? def.rest;
      return String(segment);
    }
    const field =
      typeof segment === "string" ? shapeWith(def, segment) : undefined;
    current = field;
    return field === undefined ? "*" : String(segment);
  });
  return parts.join(".") || "(root)";
};
