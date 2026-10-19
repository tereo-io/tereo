import { ForbiddenError, NotFoundError } from "../utils/errors.js";
import { AuthServiceClient } from "../clients/auth.js";
import { describe, expect, it } from "vitest";
import type { Request } from "express";

const { validateOrganization } = new AuthServiceClient();
const org = { id: "org-1", code: "org-one", name: "Org One" };

describe("validateOrganization", () => {
  it("returns the organization when it matches", () => {
    const req = { organization: org } as unknown as Request;
    expect(validateOrganization(req)).toBe(org);
    expect(validateOrganization(req, "org-1")).toBe(org);
  });

  it("answers another organization's resource as not found", () => {
    const req = { organization: org } as unknown as Request;
    let caught: unknown;
    try {
      validateOrganization(req, "org-2");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect(caught).toMatchObject({ statusCode: 404, code: "not_found" });
  });

  it("refuses a request without an organization", () => {
    const req = {} as Request;
    expect(() => validateOrganization(req, "org-1")).toThrow(ForbiddenError);
    expect(() => validateOrganization(req)).toThrow(
      expect.objectContaining({ statusCode: 403 })
    );
  });
});
