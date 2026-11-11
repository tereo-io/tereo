// @module-tag unit
// @module-tag auth
// @module-tag security
import { refuseForeignOrigins } from "../../middleware/originCheck.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import env from "../../env.js";

const LISTED_ORIGIN = "https://app.example.com";

const run = (method: string, headers: Record<string, string>) => {
  const req = {
    method,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  const next = vi.fn();
  refuseForeignOrigins(req, {} as Response, next);
  return next;
};

describe("refuseForeignOrigins", () => {
  const listed = env.CORS_ALLOWED_ORIGINS;
  afterEach(() => {
    env.CORS_ALLOWED_ORIGINS = listed;
  });

  it("passes an origin listed in CORS_ALLOWED_ORIGINS, from any site", () => {
    env.CORS_ALLOWED_ORIGINS = [LISTED_ORIGIN];
    expect(
      run("POST", { origin: LISTED_ORIGIN, "sec-fetch-site": "cross-site" })
    ).toHaveBeenCalledWith();
    expect(() =>
      run("POST", { origin: "https://other.example.com" })
    ).toThrowError(expect.objectContaining({ statusCode: 403 }));
  });

  it("passes every origin when CORS_ALLOWED_ORIGINS is *", () => {
    env.CORS_ALLOWED_ORIGINS = "*";
    expect(
      run("POST", { origin: "https://other.example.com" })
    ).toHaveBeenCalledWith();
  });

  it("passes core, the UI, same-origin and a request with no Origin", () => {
    env.CORS_ALLOWED_ORIGINS = [];
    const allowed: Record<string, string>[] = [
      {},
      { origin: new URL(env.PUBLIC_URL).origin },
      { origin: new URL(env.UI_BASE_URL).origin },
      { origin: "http://core.internal", "sec-fetch-site": "same-origin" },
    ];
    for (const headers of allowed) {
      expect(run("POST", headers)).toHaveBeenCalledWith();
    }
  });

  it("refuses another origin, an opaque one, and leaves safe methods alone", () => {
    env.CORS_ALLOWED_ORIGINS = [];
    for (const origin of ["https://other.example.com", "null"]) {
      expect(() => run("POST", { origin })).toThrowError(
        expect.objectContaining({ statusCode: 403 })
      );
      expect(run("GET", { origin })).toHaveBeenCalledWith();
    }
  });
});
