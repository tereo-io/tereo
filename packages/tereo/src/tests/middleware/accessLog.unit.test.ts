// @module-tag unit
// @module-tag platform
import { accessLogErrorMessage } from "../../middleware/accessLog.js";
import { describe, expect, it } from "vitest";

describe("accessLogErrorMessage", () => {
  it("keeps only a Prisma error's class and code", () => {
    const validation = new Error('data: { password: "hunter2-secret" }');
    validation.name = "PrismaClientValidationError";
    expect(accessLogErrorMessage(validation)).toBe(
      "PrismaClientValidationError"
    );
    const known = Object.assign(new Error("Unique constraint failed"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    });
    expect(accessLogErrorMessage(known)).toBe(
      "PrismaClientKnownRequestError P2002"
    );
  });

  it("keeps other errors' messages", () => {
    expect(accessLogErrorMessage(new Error("No such bucket"))).toBe(
      "No such bucket"
    );
    expect(accessLogErrorMessage(undefined)).toBeUndefined();
  });
});
