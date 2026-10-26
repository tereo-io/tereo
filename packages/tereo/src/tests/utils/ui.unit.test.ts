// @module-tag unit
// @module-tag platform
import { isReservedPath, resolveUiBaseUrl } from "../../utils/ui.js";
import { describe, expect, it } from "vitest";

describe("resolveUiBaseUrl", () => {
  it("defaults to the Vite dev server outside production", () => {
    expect(resolveUiBaseUrl({ NODE_ENV: "development" })).toBe(
      "http://localhost:4000"
    );
    expect(resolveUiBaseUrl({ NODE_ENV: "test" })).toBe(
      "http://localhost:4000"
    );
  });

  it("defaults to PUBLIC_URL in production", () => {
    expect(
      resolveUiBaseUrl({
        NODE_ENV: "production",
        PUBLIC_URL: "https://core.example.com/",
      })
    ).toBe("https://core.example.com");
  });

  it("prefers an explicit UI_BASE_URL, without its trailing slash", () => {
    expect(
      resolveUiBaseUrl({
        NODE_ENV: "production",
        PUBLIC_URL: "https://core.example.com",
        UI_BASE_URL: "https://admin.example.com/",
      })
    ).toBe("https://admin.example.com");
  });
});

describe("isReservedPath", () => {
  it.each([
    "/v1",
    "/v1/admin/users",
    "/oauth/token",
    "/.well-known/jwks.json",
    "/health",
    "/ws/x",
    "/assets/x.js",
    "/V1",
    "/OAuth/token",
  ])("reserves %s for core", (path) => expect(isReservedPath(path)).toBe(true));

  it.each([
    "/",
    "/v1x",
    "/v2",
    "/auth-admin",
    "/oauthish",
    "/healthz",
    "/shared/abc",
  ])("leaves %s to the UI", (path) => expect(isReservedPath(path)).toBe(false));
});
