import { afterEach, describe, expect, it } from "vitest";
import {
  activeConfig,
  resolveConfig,
  setActiveConfig,
  type TereoAuthConfig,
} from "../config.js";

const base: TereoAuthConfig = {
  coreUrl: "https://core.example.com",
  clientId: "app",
  redirectUri: "https://app.example.com/base/callback",
  apis: { core: "https://core.example.com" },
  loadUser: async () => ({ permissions: [] }),
};

afterEach(() => setActiveConfig(null));

describe("resolveConfig", () => {
  it("fills defaults", () => {
    const c = resolveConfig(base);
    expect(c).toMatchObject({
      scopes: "openid profile email offline_access",
      basePath: "",
      signedOutPath: "/",
      storagePrefix: "tereo_app",
      tokenExpirationBuffer: 30_000,
      requestTimeoutMs: 15_000,
      live: true,
      wsPath: "/ws",
      debug: false,
    });
    expect(c.onEvent).toBeUndefined();
  });

  it("derives storage keys from the client id by default", () => {
    expect(resolveConfig(base).keys).toEqual({
      tokens: "tereo_app_tokens",
      pkce: "tereo_app_pkce",
      loggedOut: "tereo_app_logged_out",
      signedIn: "tereo_app_signed_in",
      postLoginPath: "tereo_app_post_login_path",
    });
  });

  it("uses a given storage prefix", () => {
    const { keys } = resolveConfig({ ...base, storagePrefix: "tereo" });
    expect(keys.tokens).toBe("tereo_tokens");
    expect(keys.pkce).toBe("tereo_pkce");
    expect(keys.loggedOut).toBe("tereo_logged_out");
  });

  it("treats the redirect path and signed-out path as public by default", () => {
    const c = resolveConfig({
      ...base,
      basePath: "/base",
      signedOutPath: "/hi",
    });
    expect(c.isPublicPath("/callback")).toBe(true);
    expect(c.isPublicPath("/hi")).toBe(true);
    expect(c.isPublicPath("/dashboard")).toBe(false);
  });

  it("strips the base path only at a segment boundary", () => {
    const c = resolveConfig({
      ...base,
      basePath: "/app",
      redirectUri: "https://app.example.com/application/callback",
    });
    expect(c.isPublicPath("/application/callback")).toBe(true);
    expect(c.isPublicPath("/callback")).toBe(false);
  });

  it("keeps a given isPublicPath", () => {
    const isPublicPath = (p: string) => p === "/open";
    expect(resolveConfig({ ...base, isPublicPath }).isPublicPath).toBe(
      isPublicPath
    );
  });
});

describe("activeConfig", () => {
  it("throws when unset", () => {
    expect(() => activeConfig()).toThrow("TereoAuthProvider is not mounted");
  });

  it("returns the config that was set", () => {
    const c = resolveConfig(base);
    setActiveConfig(c);
    expect(activeConfig()).toBe(c);
  });
});
