import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, setActiveConfig } from "../config.js";
import { readTokens, writeTokens } from "../tokens.js";
import {
  clearLoggedOut,
  clearSignedIn,
  hasSession,
  isLoggedOut,
  markLoggedOut,
  markSignedIn,
} from "../markers.js";

const tokens = {
  access_token: "a",
  token_type: "Bearer",
  expires_in: 60,
  scope: "openid",
  expiresAt: Date.now() + 60_000,
};

beforeEach(() => {
  localStorage.clear();
  setActiveConfig(
    resolveConfig({
      coreUrl: "https://core.example.com",
      clientId: "app",
      redirectUri: "https://app.example.com/callback",
      apis: {},
      loadUser: async () => ({ permissions: [] }),
    })
  );
});

afterEach(() => setActiveConfig(null));

describe("tokens", () => {
  it("round-trips and clears", () => {
    expect(readTokens()).toBeNull();
    writeTokens(tokens);
    expect(readTokens()).toEqual(tokens);
    writeTokens(null);
    expect(readTokens()).toBeNull();
  });
});

describe("session markers", () => {
  it("has no session by default", () => {
    expect(hasSession()).toBe(false);
  });

  it("counts the signed-in marker", () => {
    markSignedIn();
    expect(hasSession()).toBe(true);
    clearSignedIn();
    expect(hasSession()).toBe(false);
  });

  it("treats stored tokens without a marker as signed in", () => {
    writeTokens(tokens);
    expect(hasSession()).toBe(true);
  });

  it("lets the logged-out marker beat the signed-in marker and tokens", () => {
    markSignedIn();
    writeTokens(tokens);
    markLoggedOut();
    expect(isLoggedOut()).toBe(true);
    expect(hasSession()).toBe(false);
    clearLoggedOut();
    expect(isLoggedOut()).toBe(false);
    expect(hasSession()).toBe(true);
  });
});
