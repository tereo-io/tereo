// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  isBrandedAuthPath,
  isReservedPath,
  resolveUiBaseUrl,
} from "../../utils/ui.js";

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

describe("isBrandedAuthPath", () => {
  it.each([
    "/login",
    "/login/",
    "/login/2fa",
    "/login/2fa/recovery",
    "/consent",
    "/logout",
    "/set-password",
    "/set-password/",
    "/forgot-password",
    "/verify-email",
    "/LOGIN",
    "/Consent",
  ])("brands %s", (path) => expect(isBrandedAuthPath(path)).toBe(true));

  it.each([
    "/",
    "/loginx",
    "/login-help",
    "/consents",
    "/auth-admin/users",
    "/account/profile",
    "/callback",
    "/shared/abc",
  ])("leaves %s unbranded", (path) =>
    expect(isBrandedAuthPath(path)).toBe(false)
  );

  it("checks a long run of slashes that is not at the end in linear time", () => {
    const path = `/login${"/".repeat(200_000)}x`;
    const started = performance.now();
    expect(isBrandedAuthPath(path)).toBe(true);
    expect(isBrandedAuthPath(`/x${"/".repeat(200_000)}x`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
