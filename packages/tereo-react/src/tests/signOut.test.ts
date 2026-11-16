import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig, setActiveConfig } from "../config.js";
import { isLoggedOut, markSignedIn } from "../markers.js";
import { endLocalSession, signOut } from "../signOut.js";
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
  signedOutPath: "/signed-out",
  basePath: "/ui",
  requestTimeoutMs: 5_000,
});

const b64 = (o: object) =>
  btoa(JSON.stringify(o))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const idTokenExpiring = (exp: number) =>
  `${b64({ alg: "none" })}.${b64({ exp })}.sig`;
const now = () => Math.floor(Date.now() / 1000);

let href = "";
// What the marker held when the first request went out.
let markedAtFirstCall: boolean | null = null;

const storeTokens = (id_token?: string) =>
  localStorage.setItem(
    config.keys.tokens,
    JSON.stringify({
      access_token: "a",
      id_token,
      token_type: "Bearer",
      expires_in: 900,
      scope: "openid",
      expiresAt: Date.now() + 900_000,
    })
  );

const urlsCalled = () => post.mock.calls.map((c) => c[0]);

beforeEach(() => {
  localStorage.clear();
  href = "";
  markedAtFirstCall = null;
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
  post.mockImplementation(async () => {
    markedAtFirstCall ??= isLoggedOut();
    return {};
  });
  markSignedIn();
});

afterEach(() => setActiveConfig(null));

describe("signOut", () => {
  it("marks logged out first, then revokes and ends the session with the hint", async () => {
    const idToken = idTokenExpiring(now() + 600);
    storeTokens(idToken);

    await signOut();

    expect(markedAtFirstCall).toBe(true);
    expect(urlsCalled().sort()).toEqual([
      "https://core.example.com/oauth/end-session",
      "https://core.example.com/oauth/revoke",
    ]);
    const end = post.mock.calls.find((c) =>
      String(c[0]).endsWith("end-session")
    )!;
    const form = end[1] as URLSearchParams;
    expect(form.get("client_id")).toBe("app");
    expect(form.get("id_token_hint")).toBe(idToken);
    expect(end[2]).toMatchObject({ withCredentials: true, timeout: 5_000 });
    const revoke = post.mock.calls.find((c) =>
      String(c[0]).endsWith("revoke")
    )!;
    expect((revoke[1] as URLSearchParams).get("token_type_hint")).toBe(
      "refresh_token"
    );

    expect(readTokens()).toBeNull();
    expect(localStorage.getItem(config.keys.signedIn)).toBeNull();
    expect(isLoggedOut()).toBe(true);
    expect(href).toBe("/ui/signed-out");
  });

  it("still ends the session when the revoke fails", async () => {
    storeTokens(idTokenExpiring(now() + 600));
    post.mockImplementation(async (url) => {
      if (String(url).endsWith("revoke")) throw new Error("down");
      return {};
    });

    await signOut();

    expect(urlsCalled()).toContain(
      "https://core.example.com/oauth/end-session"
    );
    expect(readTokens()).toBeNull();
    expect(href).toBe("/ui/signed-out");
  });

  it("logs revoke and end-session failures", async () => {
    storeTokens(idTokenExpiring(now() + 600));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    post.mockRejectedValue(new Error("down"));

    await signOut();

    const messages = log.mock.calls.map((c) => c[1]);
    expect(messages).toContain("Token revocation request failed");
    expect(messages).toContain("End-session request failed");
    log.mockRestore();
  });

  it("does not log when there is simply no id token to end the session with", async () => {
    storeTokens(undefined);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await signOut();

    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("still revokes when end-session fails, and goes to core's confirmation page", async () => {
    storeTokens(idTokenExpiring(now() + 600));
    post.mockImplementation(async (url) => {
      if (String(url).endsWith("end-session")) throw new Error("down");
      return {};
    });

    await signOut();

    expect(urlsCalled()).toContain("https://core.example.com/oauth/revoke");
    expect(readTokens()).toBeNull();
    expect(localStorage.getItem(config.keys.signedIn)).toBeNull();
    expect(href).toBe(
      "https://core.example.com/oauth/end-session?client_id=app"
    );
  });

  it("revokes only and sends the user to the confirmation page without an id token", async () => {
    storeTokens(undefined);

    await signOut();

    expect(urlsCalled()).toEqual(["https://core.example.com/oauth/revoke"]);
    expect(href).toBe(
      "https://core.example.com/oauth/end-session?client_id=app"
    );
  });

  it("treats an id token expired beyond core's grace as unusable", async () => {
    storeTokens(idTokenExpiring(now() - 2 * 3600));

    await signOut();

    expect(urlsCalled()).toEqual(["https://core.example.com/oauth/revoke"]);
    expect(href).toContain("/oauth/end-session?client_id=app");
  });

  it("uses an id token expired within the grace", async () => {
    storeTokens(idTokenExpiring(now() - 600));

    await signOut();

    expect(urlsCalled()).toContain(
      "https://core.example.com/oauth/end-session"
    );
    expect(href).toBe("/ui/signed-out");
  });
});

describe("endLocalSession", () => {
  it("clears the session here and goes to the signed-out path, calling no one", () => {
    storeTokens(idTokenExpiring(now() + 600));

    endLocalSession();

    expect(post).not.toHaveBeenCalled();
    expect(readTokens()).toBeNull();
    expect(localStorage.getItem(config.keys.signedIn)).toBeNull();
    expect(isLoggedOut()).toBe(true);
    expect(href).toBe("/ui/signed-out");
  });
});
