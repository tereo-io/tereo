import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLoggedOut, readStoredTokens } from "./logoutMarker";
import { act, renderHook } from "@testing-library/react";
import useRefreshToken from "./useRefreshToken";
import type { StoredTokens } from "./types";
import { configureAuth } from "./config";
import type { ReactNode } from "react";
import axiosBase from "axios";

const TOKEN_KEY = "tereo_tokens";

const base64url = (value: object) =>
  btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const accessTokenFor = (sub: string) =>
  `${base64url({ alg: "RS256" })}.${base64url({ sub, exp: 0 })}.signature`;

const stored = (sub: string): StoredTokens => ({
  access_token: accessTokenFor(sub),
  token_type: "Bearer",
  expires_in: 3600,
  scope: "openid",
  // Expired: what the tab holds when it refreshes.
  expiresAt: Date.now() - 1000,
});

const answerWith = (sub: string) =>
  vi.spyOn(axiosBase, "post").mockResolvedValue({
    data: {
      access_token: accessTokenFor(sub),
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid",
    },
  });

const renderRefresh = () => {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useRefreshToken(), { wrapper });
};

beforeEach(() => {
  configureAuth({
    AUTH_SERVER_URL: "http://core.test",
    REDIRECT_URI: "http://ui.test/callback",
    CLIENT_ID: "tereo-ui",
  });
  localStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useRefreshToken", () => {
  it("does not adopt a token for another user than the tab was signed in as", async () => {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(stored("user-1")));
    answerWith("user-2");
    const { result } = renderRefresh();

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow(
        "another user"
      );
    });

    expect(readStoredTokens()).toBeNull();
    // The cookie that answered is not refreshed from again.
    expect(isLoggedOut()).toBe(true);
  });

  it("adopts a token for the same user", async () => {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(stored("user-1")));
    const fresh = accessTokenFor("user-1").replace("signature", "fresh");
    vi.spyOn(axiosBase, "post").mockResolvedValue({
      data: {
        access_token: fresh,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid",
      },
    });
    const { result } = renderRefresh();

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(readStoredTokens()?.access_token).toBe(fresh);
    expect(isLoggedOut()).toBe(false);
  });

  it("adopts whoever the cookie is for when the tab holds no token", async () => {
    answerWith("user-2");
    const { result } = renderRefresh();

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(readStoredTokens()?.access_token).toBe(accessTokenFor("user-2"));
    expect(isLoggedOut()).toBe(false);
  });
});
