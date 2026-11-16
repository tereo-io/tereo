import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasSession, isLoggedOut, markLoggedOut } from "../markers.js";
import { resolveConfig, setActiveConfig } from "../config.js";
import { completeSignIn, signIn } from "../signIn.js";
import { readTokens } from "../tokens.js";
import axios from "axios";

vi.mock("axios", () => ({ default: { post: vi.fn() } }));

const post = vi.mocked(axios.post);
const config = resolveConfig({
  coreUrl: "https://core.example.com",
  clientId: "app",
  redirectUri: "https://app.example.com/callback",
  apis: {},
  loadUser: async () => ({ permissions: [] }),
  scopes: "openid profile",
  requestTimeoutMs: 5_000,
});

const b64 = (o: object) =>
  btoa(JSON.stringify(o))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const jwt = (claims: object) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;

let href = "";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  href = "";
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() {
        return href;
      },
      set href(v: string) {
        href = v;
      },
    },
  });
  setActiveConfig(config);
  post.mockReset();
});

afterEach(() => {
  setActiveConfig(null);
  vi.useRealTimers();
});

const startSignIn = async (opts?: Parameters<typeof signIn>[0]) => {
  await signIn(opts);
  const url = new URL(href);
  return { url, p: url.searchParams };
};

const tokenResponse = (claims: object = {}, extra: object = {}) => ({
  data: {
    access_token: "access",
    id_token: jwt({ aud: "app", ...claims }),
    token_type: "Bearer",
    expires_in: 900,
    scope: "openid profile",
    ...extra,
  },
});

describe("signIn", () => {
  it("redirects to the authorize endpoint and saves PKCE per tab", async () => {
    const { url, p } = await startSignIn({ params: { org_id: "org1" } });
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://core.example.com/oauth/authorize"
    );
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("app");
    expect(p.get("redirect_uri")).toBe("https://app.example.com/callback");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toBeTruthy();
    expect(p.get("scope")).toBe("openid profile");
    expect(p.get("org_id")).toBe("org1");

    const saved = JSON.parse(sessionStorage.getItem(config.keys.pkce)!);
    expect(saved.state).toBe(p.get("state"));
    expect(saved.nonce).toBe(p.get("nonce"));
    expect(localStorage.getItem(config.keys.pkce)).toBeNull();
  });

  it("lets the protocol parameters win over params, but not scope", async () => {
    const { p } = await startSignIn({
      params: { state: "forged", client_id: "evil", scope: "openid" },
    });
    const saved = JSON.parse(sessionStorage.getItem(config.keys.pkce)!);
    expect(p.get("state")).toBe(saved.state);
    expect(p.get("client_id")).toBe("app");
    expect(p.get("scope")).toBe("openid");
  });

  it("keeps returnTo only for in-app paths", async () => {
    const kept = async (returnTo: string) => {
      sessionStorage.clear();
      await signIn({ returnTo });
      return sessionStorage.getItem(config.keys.postLoginPath);
    };
    expect(await kept("/a/b")).toBe("/a/b");
    expect(await kept("//evil")).toBeNull();
    expect(await kept("https://evil")).toBeNull();
    expect(await kept("/a\\b")).toBeNull();
  });
});

describe("completeSignIn", () => {
  const begin = async (opts?: Parameters<typeof signIn>[0]) => {
    const { p } = await startSignIn(opts);
    return { state: p.get("state")!, nonce: p.get("nonce")! };
  };
  const search = (state: string, code = "code1") =>
    new URLSearchParams({ code, state });

  it("exchanges the code, stores tokens and the marker, returns the path", async () => {
    const { state, nonce } = await begin({ returnTo: "/a/b" });
    markLoggedOut();
    post.mockResolvedValue(tokenResponse({ nonce }));

    await expect(completeSignIn(search(state))).resolves.toEqual({
      returnTo: "/a/b",
    });

    const [url, body, cfg] = post.mock.calls[0];
    expect(url).toBe("https://core.example.com/oauth/token");
    const form = body as URLSearchParams;
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code1");
    expect(form.get("client_id")).toBe("app");
    expect(form.get("redirect_uri")).toBe("https://app.example.com/callback");
    expect(form.get("code_verifier")).toBeTruthy();
    expect(form.get("refresh_token_response_mode")).toBe("cookie");
    expect(cfg).toMatchObject({ withCredentials: true, timeout: 5_000 });

    expect(readTokens()?.access_token).toBe("access");
    expect(readTokens()!.expiresAt).toBeGreaterThan(Date.now());
    expect(localStorage.getItem(config.keys.signedIn)).not.toBeNull();
    expect(isLoggedOut()).toBe(false);
    expect(hasSession()).toBe(true);
    expect(sessionStorage.getItem(config.keys.pkce)).toBeNull();
  });

  it("returns null when no return path was saved", async () => {
    const { state, nonce } = await begin();
    post.mockResolvedValue(tokenResponse({ nonce }));
    await expect(completeSignIn(search(state))).resolves.toEqual({
      returnTo: null,
    });
  });

  it("refuses a state that differs from the saved one", async () => {
    await begin();
    await expect(completeSignIn(search("other"))).rejects.toThrow(
      /does not match/
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses when no sign-in was started in this tab", async () => {
    await expect(completeSignIn(search("x"))).rejects.toThrow(/does not match/);
  });

  it("refuses an ID token with a different nonce", async () => {
    const { state } = await begin();
    post.mockResolvedValue(tokenResponse({ nonce: "wrong" }));
    await expect(completeSignIn(search(state))).rejects.toThrow(/nonce/);
    expect(readTokens()).toBeNull();
    expect(sessionStorage.getItem(config.keys.pkce)).toBeNull();
  });

  it("refuses an ID token issued to a different client", async () => {
    const { state, nonce } = await begin();
    post.mockResolvedValue(tokenResponse({ nonce, aud: "other" }));
    await expect(completeSignIn(search(state))).rejects.toThrow(
      /different client/
    );
    expect(readTokens()).toBeNull();
  });

  it("refuses a response without an ID token", async () => {
    const { state } = await begin();
    post.mockResolvedValue(tokenResponse({}, { id_token: undefined }));
    await expect(completeSignIn(search(state))).rejects.toThrow(/nonce/);
  });

  it("clears PKCE even when the exchange fails", async () => {
    const { state } = await begin();
    post.mockRejectedValue(new Error("network"));
    await expect(completeSignIn(search(state))).rejects.toThrow("network");
    expect(sessionStorage.getItem(config.keys.pkce)).toBeNull();
  });

  it("rejects when the token request does not answer in time", async () => {
    vi.useFakeTimers();
    const { state } = await begin();
    post.mockImplementation(
      (_u, _b, cfg) =>
        new Promise((_res, rej) =>
          setTimeout(
            () => rej(new Error(`timeout of ${cfg?.timeout}ms exceeded`)),
            cfg?.timeout
          )
        )
    );
    const result = completeSignIn(search(state));
    const assertion = expect(result).rejects.toThrow("timeout of 5000ms");
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("rejects with core's error code", async () => {
    await begin();
    await expect(
      completeSignIn(new URLSearchParams({ error: "access_denied" }))
    ).rejects.toThrow("access_denied");
    expect(post).not.toHaveBeenCalled();
  });

  it("clears the saved PKCE entry when core's error carries its state", async () => {
    const { state } = await begin();
    await expect(
      completeSignIn(new URLSearchParams({ error: "access_denied", state }))
    ).rejects.toThrow("access_denied");
    expect(sessionStorage.getItem(config.keys.pkce)).toBeNull();
  });

  it("keeps the saved PKCE entry when the error's state differs", async () => {
    await begin();
    await expect(
      completeSignIn(
        new URLSearchParams({ error: "access_denied", state: "other" })
      )
    ).rejects.toThrow("access_denied");
    expect(sessionStorage.getItem(config.keys.pkce)).not.toBeNull();
  });

  it("rejects a callback without code or state", async () => {
    await expect(completeSignIn(new URLSearchParams())).rejects.toThrow(/code/);
  });
});
