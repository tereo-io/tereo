// @module-tag unit
// @module-tag auth
import { toScimError } from "../../../utils/scim/errors.js";
import { describe, expect, it } from "vitest";
import {
  UnauthorizedError,
  BadRequestError,
  ValidationError,
  ConflictError,
  NotFoundError,
} from "../../../utils/errors.js";

const URN = "urn:ietf:params:scim:api:messages:2.0:Error";

describe("toScimError", () => {
  it.each([
    ["validation", new ValidationError("bad"), 400, "invalidValue", "bad"],
    [
      "invalidFilter",
      new BadRequestError("invalidFilter", "f"),
      400,
      "invalidFilter",
      "f",
    ],
    [
      "invalidSyntax",
      new BadRequestError("invalidSyntax", "s"),
      400,
      "invalidSyntax",
      "s",
    ],
    [
      "invalidPath",
      new BadRequestError("invalidPath", "p"),
      400,
      "invalidPath",
      "p",
    ],
    [
      "invalidValue",
      new BadRequestError("invalidValue", "v"),
      400,
      "invalidValue",
      "v",
    ],
    [
      "uniqueness",
      new ConflictError("dup", "uniqueness"),
      409,
      "uniqueness",
      "dup",
    ],
    ["other conflict", new ConflictError("c"), 409, undefined, "c"],
    [
      "other bad request",
      new BadRequestError("other", "o"),
      400,
      undefined,
      "o",
    ],
    ["not found", new NotFoundError("nf"), 404, undefined, "nf"],
    ["unauthorized", new UnauthorizedError("no"), 401, undefined, "no"],
  ])("maps %s", (_name, err, status, scimType, detail) => {
    const result = toScimError(err);
    expect(result.status).toBe(status);
    expect(result.body).toEqual({
      schemas: [URN],
      status: String(status),
      ...(scimType && { scimType }),
      detail,
    });
  });

  it("maps an unexpected error to a generic 500", () => {
    const result = toScimError(new Error("secret internals"));
    expect(result.status).toBe(500);
    expect(result.body.detail).not.toContain("secret");
    expect(result.body.status).toBe("500");
  });

  it("maps a malformed JSON body to 400 invalidSyntax", () => {
    const err = Object.assign(new SyntaxError("Unexpected token"), {
      status: 400,
      type: "entity.parse.failed",
    });
    expect(toScimError(err).body.scimType).toBe("invalidSyntax");
  });

  it("maps an oversized body to 413", () => {
    const err = Object.assign(new Error("too large"), {
      status: 413,
      type: "entity.too.large",
    });
    expect(toScimError(err).status).toBe(413);
  });
});
