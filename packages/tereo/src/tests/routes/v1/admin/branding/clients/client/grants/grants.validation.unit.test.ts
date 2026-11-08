// @module-tag unit
// @module-tag auth
import { GrantParamsSchema } from "../../../../../../../../routes/v1/admin/branding/clients/client/grants/grant/schemas.js";
import { AddGrantSchema } from "../../../../../../../../routes/v1/admin/branding/clients/client/grants/schemas.js";
import { describe, expect, it } from "vitest";

const uuid = "00000000-0000-7000-8000-000000000000";

describe("grant request validation", () => {
  it.each([
    ["no userId", {}],
    ["a bad uuid", { userId: "nope" }],
    ["an extra key", { userId: uuid, role: "x" }],
  ])("POST body with %s is rejected", (_name, body) => {
    expect(AddGrantSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ["a bad client id", { id: "nope", userId: uuid }],
    ["a bad :userId", { id: uuid, userId: "nope" }],
  ])("DELETE params with %s are rejected", (_name, params) => {
    expect(GrantParamsSchema.safeParse(params).success).toBe(false);
  });

  it("accepts a valid body and params", () => {
    expect(AddGrantSchema.safeParse({ userId: uuid }).success).toBe(true);
    expect(
      GrantParamsSchema.safeParse({ id: uuid, userId: uuid }).success
    ).toBe(true);
  });
});
