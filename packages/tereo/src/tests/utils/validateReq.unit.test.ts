// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { z } from "zod";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../../utils/validateReq.js";

const UPPER = "019A6F3E-8C1D-7ABC-9DEF-0123456789AB";
const LOWER = UPPER.toLowerCase();

const req = (part: Partial<Request>) => part as Request;

describe("validateParams, validateQuery, validateBody", () => {
  it("returns a UUID param in lower case and leaves other strings alone", () => {
    const schema = z.object({ id: z.guid(), name: z.string() });
    expect(
      validateParams(schema, req({ params: { id: UPPER, name: UPPER } }))
    ).toEqual({ id: LOWER, name: UPPER });
  });

  it("lower-cases a z.uuid() as it does a z.guid()", () => {
    const schema = z.object({ id: z.uuid() });
    expect(validateParams(schema, req({ params: { id: UPPER } }))).toEqual({
      id: LOWER,
    });
  });

  it("lower-cases UUIDs in a query, through optional and union", () => {
    const schema = z.object({
      versionId: z.guid().optional(),
      organizationId: z.union([z.literal("global"), z.guid()]).optional(),
      scope: z.union([z.literal("global"), z.guid()]),
    });
    expect(
      validateQuery(
        schema,
        req({
          query: { versionId: UPPER, organizationId: UPPER, scope: "global" },
        })
      )
    ).toEqual({ versionId: LOWER, organizationId: LOWER, scope: "global" });
  });

  it("lower-cases UUIDs in a body, through arrays, nested objects and nullable", () => {
    const schema = z
      .object({
        ids: z.array(z.guid()).max(10),
        owner: z.object({ userId: z.guid().nullish() }),
        missing: z.guid().optional(),
        none: z.guid().nullable(),
        label: z.string(),
      })
      .strict();
    expect(
      validateBody(
        schema,
        req({
          body: {
            ids: [UPPER, LOWER],
            owner: { userId: UPPER },
            none: null,
            label: UPPER,
          },
        })
      )
    ).toEqual({
      ids: [LOWER, LOWER],
      owner: { userId: LOWER },
      none: null,
      label: UPPER,
    });
  });
});
