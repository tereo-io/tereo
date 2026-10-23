// @module-tag unit
// @module-tag platform
import { uniqueViolationFields } from "../../utils/prismaErrors.js";
import { describe, expect, it } from "vitest";

describe("uniqueViolationFields", () => {
  it("reads the driver adapter's constraint fields", () => {
    const err = {
      code: "P2002",
      meta: {
        modelName: "UserIdentity",
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: {
            originalCode: "23505",
            kind: "UniqueConstraintViolation",
            constraint: { fields: ["user_id", "provider_id"] },
          },
        },
      },
    };
    expect(uniqueViolationFields(err)).toEqual(["user_id", "provider_id"]);
  });

  it("reads the columns from the index name when that is all it has", () => {
    const err = {
      code: "P2002",
      meta: {
        modelName: "UserIdentity",
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: {
            originalCode: "23505",
            kind: "UniqueConstraintViolation",
            constraint: { index: "user_identities_user_id_provider_id_key" },
            table: "user_identities",
          },
        },
      },
    };
    expect(uniqueViolationFields(err)).toEqual(["user_id_provider_id"]);
  });

  it("reads meta.target as an array", () => {
    expect(
      uniqueViolationFields({ code: "P2002", meta: { target: ["email"] } })
    ).toEqual(["email"]);
  });

  it("reads meta.target as a string", () => {
    expect(
      uniqueViolationFields({
        code: "P2002",
        meta: { target: "users_email_key" },
      })
    ).toEqual(["users_email_key"]);
  });

  it("reads a raw adapter error", () => {
    expect(
      uniqueViolationFields({
        cause: {
          kind: "UniqueConstraintViolation",
          constraint: { fields: ["email"] },
        },
      })
    ).toEqual(["email"]);
  });

  it("returns null for anything else", () => {
    expect(uniqueViolationFields({ code: "P2003", meta: {} })).toBeNull();
    expect(uniqueViolationFields(new Error("boom"))).toBeNull();
    expect(uniqueViolationFields(null)).toBeNull();
  });
});
