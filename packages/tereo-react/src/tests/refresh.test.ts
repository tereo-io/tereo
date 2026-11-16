import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLoggedOut, markLoggedOut, markSignedIn } from "../markers.js";
import { isRefreshRejected, refreshTokens } from "../refresh.js";
import { resolveConfig, setActiveConfig } from "../config.js";
import { type StoredTokens, readTokens } from "../tokens.js";
import axios, { AxiosError } from "axios";

vi.mock("axios", async (importOriginal) => ({
  ...(await importOriginal<typeof import("axios")>()),
  default: { post: vi.fn() },
}));

const post = vi.mocked(axios.post);
const config = resolveConfig({
  coreUrl: "https://core.example.com",
  clientId: "app",
  redirectUri: "https://app.example.com/callback",
  apis: {},
  loadUser: async () => ({ permissions: [] }),
  requestTimeoutMs: 5_000,
});

const b64 = (o: object) =>
  btoa(JSON.stringify(o))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const accessTokenFor = (sub: string, tag = "signature") =>
  `${b64({ alg: "RS256" })}.${b64({ sub, exp: 0 })}.${tag}`;

const stored = (
  sub: string,
  extra: Partial<StoredTokens> = {}
): StoredTokens => ({
  access_token: accessTokenFor(sub),
  token_type: "Bearer",
  expires_in: 3600,
  scope: "openid",
  // Expired: what the tab holds when it refreshes.
  expiresAt: Date.now() - 1000,
  ...extra,
});

const setStored = (t: StoredTokens) =>
  localStorage.setItem(config.keys.tokens, JSON.stringify(t));

const answerWith = (sub: string, extra: object = {}) =>
  post.mockResolvedValue({
    data: {
      access_token: accessTokenFor(sub, "fresh"),
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid",
      ...extra,
    },
  });

const rejectedWith = (status: number) =>
  new AxiosError("failed", "ERR", undefined, undefined, {
    status,
  } as never);

const logError = vi.spyOn(console, "error");

beforeEach(() => {
  logError.mockReset().mockImplementation(() => {});
  localStorage.clear();
  setActiveConfig(config);
  post.mockReset();
});

afterEach(() => {
  setActiveConfig(null);
  vi.unstubAllGlobals();
});

describe("refreshTokens", () => {
  it("posts the refresh grant with credentials and the timeout", async () => {
    setStored(stored("user-1"));
    answerWith("user-1");
    await refreshTokens();

    const [url, body, cfg] = post.mock.calls[0];
    expect(url).toBe("https://core.example.com/oauth/token");
    const form = body as URLSearchParams;
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("app");
    expect(form.get("refresh_token_response_mode")).toBe("cookie");
    expect(cfg).toMatchObject({ withCredentials: true, timeout: 5_000 });
  });

  it("does not adopt a token for another user than the tab was signed in as", async () => {
    setStored(stored("user-1"));
    answerWith("user-2");

    await expect(refreshTokens()).rejects.toThrow("another user");

    expect(readTokens()).toBeNull();
    // The cookie that answered is not refreshed from again.
    expect(isLoggedOut()).toBe(true);
  });

  it("adopts a token for the same user", async () => {
    setStored(stored("user-1"));
    answerWith("user-1");

    await refreshTokens();

    expect(readTokens()?.access_token).toBe(accessTokenFor("user-1", "fresh"));
    expect(readTokens()!.expiresAt).toBeGreaterThan(Date.now());
    expect(isLoggedOut()).toBe(false);
  });

  it("adopts whoever the cookie is for when the tab holds no token", async () => {
    answerWith("user-2");
    await refreshTokens();
    expect(readTokens()?.access_token).toBe(accessTokenFor("user-2", "fresh"));
    expect(isLoggedOut()).toBe(false);
  });

  it("keeps the stored id_token when the response has none", async () => {
    setStored(stored("user-1", { id_token: "old-id" }));
    answerWith("user-1");
    await refreshTokens();
    expect(readTokens()?.id_token).toBe("old-id");
  });

  it("takes the response's id_token when it has one", async () => {
    setStored(stored("user-1", { id_token: "old-id" }));
    answerWith("user-1", { id_token: "new-id" });
    await refreshTokens();
    expect(readTokens()?.id_token).toBe("new-id");
  });

  it("shares one request between concurrent callers", async () => {
    setStored(stored("user-1"));
    answerWith("user-1");
    const [a, b] = await Promise.all([refreshTokens(), refreshTokens()]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("clears the tokens and the signed-in marker when core rejects the refresh", async () => {
    setStored(stored("user-1"));
    markSignedIn();
    post.mockRejectedValue(rejectedWith(400));

    await expect(refreshTokens()).rejects.toThrow();

    expect(readTokens()).toBeNull();
    expect(localStorage.getItem(config.keys.signedIn)).toBeNull();
  });

  it("logs a failed refresh", async () => {
    setStored(stored("user-1"));
    post.mockRejectedValue(rejectedWith(500));

    await expect(refreshTokens()).rejects.toBeDefined();

    expect(logError.mock.calls[0][1]).toBe("Token refresh failed:");
  });

  it("keeps the tokens and the marker on other errors", async () => {
    const tokens = stored("user-1");
    setStored(tokens);
    markSignedIn();
    post.mockRejectedValue(rejectedWith(503));

    await expect(refreshTokens()).rejects.toThrow();

    expect(readTokens()).toEqual(tokens);
    expect(localStorage.getItem(config.keys.signedIn)).not.toBeNull();
  });

  it("refresh across tabs adopts the other tab's token", async () => {
    setStored(stored("user-1"));
    const fresh = stored("user-1", {
      access_token: accessTokenFor("user-1", "other-tab"),
      expiresAt: Date.now() + 3_600_000,
    });
    // The other tab holds the lock, stores its token, and releases it.
    const request = vi.fn(
      async (_name: string, run: () => Promise<unknown>) => {
        setStored(fresh);
        return run();
      }
    );
    vi.stubGlobal("navigator", { locks: { request } });

    await expect(refreshTokens()).resolves.toEqual(fresh);

    expect(request.mock.calls[0][0]).toBe("tereo_refresh_app");
    expect(post).not.toHaveBeenCalled();
  });

  it("does not refresh after sign-out in another tab", async () => {
    setStored(stored("user-1"));
    const request = vi.fn(
      async (_name: string, run: () => Promise<unknown>) => {
        markLoggedOut();
        return run();
      }
    );
    vi.stubGlobal("navigator", { locks: { request } });

    await expect(refreshTokens()).rejects.toThrow("Signed out");

    expect(post).not.toHaveBeenCalled();
  });

  it("does not adopt another tab's token after sign-out", async () => {
    setStored(stored("user-1"));
    const request = vi.fn(
      async (_name: string, run: () => Promise<unknown>) => {
        setStored(
          stored("user-1", {
            access_token: accessTokenFor("user-1", "other-tab"),
            expiresAt: Date.now() + 3_600_000,
          })
        );
        markLoggedOut();
        return run();
      }
    );
    vi.stubGlobal("navigator", { locks: { request } });

    await expect(refreshTokens()).rejects.toThrow("Signed out");

    expect(post).not.toHaveBeenCalled();
  });

  it("fails when sign-out lands while the request is in flight", async () => {
    setStored(stored("user-1"));
    post.mockImplementation(async () => {
      markLoggedOut();
      return {
        data: {
          access_token: accessTokenFor("user-1", "fresh"),
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid",
        },
      };
    });

    await expect(refreshTokens()).rejects.toThrow("Signed out");
    expect(readTokens()?.access_token).toBe(accessTokenFor("user-1"));
  });

  it("falls back to the storage lock without navigator.locks", async () => {
    setStored(stored("user-1"));
    answerWith("user-1");
    vi.stubGlobal("navigator", {});
    await refreshTokens();
    expect(post).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("tereo_refresh_app")).toBeNull();
  });
});

describe("isRefreshRejected", () => {
  it("is true for 400 and 401 only", () => {
    expect(isRefreshRejected(rejectedWith(400))).toBe(true);
    expect(isRefreshRejected(rejectedWith(401))).toBe(true);
    expect(isRefreshRejected(rejectedWith(429))).toBe(false);
    expect(isRefreshRejected(rejectedWith(500))).toBe(false);
    expect(isRefreshRejected(new Error("offline"))).toBe(false);
  });
});
