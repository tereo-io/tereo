import { createCursorQuerySchema } from "../../utils/parseQueryString.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const schema = createCursorQuerySchema({
  filters: {
    createdAt: { operators: ["gte", "lte"], schema: z.coerce.date() },
    name: {
      operators: ["equals", "contains", "startsWith", "endsWith"],
      schema: z.string(),
    },
    active: { operators: ["equals"], schema: z.boolean() },
  },
  sortFields: { createdAt: "createdAt" },
  defaultSort: "createdAt",
});

const where = (query: Record<string, unknown>) => schema.parse(query).where;

const A = "2026-01-01T00:00:00.000Z";
const B = "2026-02-01T00:00:00.000Z";
const range = { createdAt: { gte: new Date(A), lte: new Date(B) } };

describe("parseQueryString filters", () => {
  it("merges _gte and _lte suffixes in either order", () => {
    expect(
      where({ "filter[createdAt_gte]": A, "filter[createdAt_lte]": B })
    ).toEqual(range);
    expect(
      where({ "filter[createdAt_lte]": B, "filter[createdAt_gte]": A })
    ).toEqual(range);
  });

  it("merges a suffix bound with an _op bound in either order", () => {
    expect(
      where({
        "filter[createdAt_lte]": B,
        "filter[createdAt]": A,
        "filter[createdAt_op]": "gte",
      })
    ).toEqual(range);
    expect(
      where({
        "filter[createdAt]": A,
        "filter[createdAt_op]": "gte",
        "filter[createdAt_lte]": B,
      })
    ).toEqual(range);
  });

  it("merges repeated _op bounds into one range", () => {
    expect(
      where({
        "filter[createdAt]": [A, B],
        "filter[createdAt_op]": ["gte", "lte"],
      })
    ).toEqual(range);
  });

  it("puts clashing clauses for one field in AND", () => {
    expect(
      where({
        "filter[createdAt_gte]": A,
        "filter[createdAt]": B,
        "filter[createdAt_op]": "gte",
      })
    ).toEqual({
      createdAt: { gte: new Date(A) },
      AND: [{ createdAt: { gte: new Date(B) } }],
    });
  });

  it("never folds a case-insensitive clause into another", () => {
    expect(
      where({
        "filter[name]": ["x", "y"],
        "filter[name_op]": ["equals", "contains"],
      })
    ).toEqual({
      name: { equals: "x" },
      AND: [{ name: { contains: "y", mode: "insensitive" } }],
    });
  });

  it("refuses a filter named after an Object member as a validation issue", () => {
    for (const key of [
      "filter[constructor]",
      "filter[toString]",
      "filter[__proto__]",
      "filter[constructor_gte]",
    ]) {
      const parse = () => schema.safeParse({ [key]: "x" });
      expect(parse, key).not.toThrow();
      expect(parse().success, key).toBe(false);
    }
  });

  it("matches a text filter against the words true and false", () => {
    expect(where({ "filter[name]": "true" })).toEqual({
      name: { equals: "true" },
    });
    expect(
      where({ "filter[name]": "false", "filter[name_op]": "contains" })
    ).toEqual({ name: { contains: "false", mode: "insensitive" } });
  });

  it("turns true and false into booleans for a boolean filter only", () => {
    expect(where({ "filter[active]": "false" })).toEqual({
      active: { equals: false },
    });
    expect(schema.safeParse({ "filter[active]": "yes" }).success).toBe(false);
  });

  it("escapes LIKE wildcards in contains, startsWith and endsWith", () => {
    for (const op of ["contains", "startsWith", "endsWith"]) {
      expect(
        where({ "filter[name]": "a_b%c\\d", "filter[name_op]": op })
      ).toEqual({ name: { [op]: "a\\_b\\%c\\\\d", mode: "insensitive" } });
    }
    expect(where({ "filter[name]": "a_b%" })).toEqual({
      name: { equals: "a_b%" },
    });
  });
});
