import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig, setActiveConfig } from "../config.js";
import { type AxiosAdapter, AxiosError } from "axios";
import { markSignedIn } from "../markers.js";
import { createApiClients } from "../api.js";
import { readTokens } from "../tokens.js";

const refreshTokens = vi.hoisted(() => vi.fn());
vi.mock("../refresh.js", () => ({ refreshTokens }));

const config = resolveConfig({
  coreUrl: "https://core.example.com",
  clientId: "app",
  redirectUri: "https://app.example.com/callback",
  apis: {},
  loadUser: async () => ({ permissions: [] }),
  tokenExpirationBuffer: 30_000,
});

const storeToken = (access_token: string, expiresInMs: number) =>
  localStorage.setItem(
    config.keys.tokens,
    JSON.stringify({
      access_token,
      token_type: "Bearer",
      expires_in: 900,
      scope: "openid",
      expiresAt: Date.now() + expiresInMs,
    })
  );

const renewedTo = (access_token: string) =>
  refreshTokens.mockImplementation(async () => {
    storeToken(access_token, 900_000);
    return { access_token };
  });

// Answers with each status in turn; records the Authorization header sent.
const respond = (...statuses: number[]) => {
  const sent: unknown[] = [];
  const adapter: AxiosAdapter = async (cfg) => {
    sent.push(cfg.headers.Authorization);
    const status = statuses.shift() ?? 200;
    const response = {
      status,
      statusText: "",
      data: {},
      headers: {},
      config: cfg,
    };
    if (status >= 400) {
      throw new AxiosError("failed", "ERR", cfg, null, response);
    }
    return response;
  };
  const { authed, open } = createApiClients({
    main: "https://api.example.com",
  });
  authed.main.defaults.adapter = adapter;
  open.main.defaults.adapter = adapter;
  return { client: authed.main, open: open.main, sent };
};

beforeEach(() => {
  localStorage.clear();
  refreshTokens.mockReset();
  setActiveConfig(config);
});

afterEach(() => setActiveConfig(null));

describe("createApiClients", () => {
  it("sends the stored token as a bearer", async () => {
    storeToken("tok", 900_000);
    const { client, sent } = respond(200);

    await client.get("/x");

    expect(sent).toEqual(["Bearer tok"]);
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it("uses the API's base URL", () => {
    const { authed, open } = createApiClients({ a: "https://a.example.com" });
    expect(authed.a.defaults.baseURL).toBe("https://a.example.com");
    expect(open.a.defaults.baseURL).toBe("https://a.example.com");
  });

  it("renews first when the token is within the buffer and a session exists", async () => {
    storeToken("old", 10_000);
    markSignedIn();
    renewedTo("new");
    const { client, sent } = respond(200);

    await client.get("/x");

    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(["Bearer new"]);
  });

  it("does not renew without a session, and sends the stale token", async () => {
    storeToken("old", 10_000);
    localStorage.setItem(config.keys.loggedOut, JSON.stringify("1"));
    const { client, sent } = respond(200);

    await client.get("/x");

    expect(refreshTokens).not.toHaveBeenCalled();
    expect(sent).toEqual(["Bearer old"]);
  });

  it("fails the request when the renewal fails", async () => {
    storeToken("old", 10_000);
    markSignedIn();
    refreshTokens.mockRejectedValue(new Error("rejected"));
    const { client, sent } = respond(200);

    await expect(client.get("/x")).rejects.toThrow("rejected");
    expect(sent).toEqual([]);
  });

  it("renews once on a 401 and retries with the new token", async () => {
    storeToken("tok", 900_000);
    markSignedIn();
    renewedTo("new");
    const { client, sent } = respond(401, 200);

    const res = await client.get("/x");

    expect(res.status).toBe(200);
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(["Bearer tok", "Bearer new"]);
  });

  it("retries a 401 with a token renewed meanwhile, without renewing again", async () => {
    storeToken("tok", 900_000);
    markSignedIn();
    renewedTo("new");
    const { client, sent } = respond(401, 200);
    const adapter = client.defaults.adapter as AxiosAdapter;
    client.defaults.adapter = async (cfg) => {
      // Another tab renews while this request is in flight.
      const res = adapter(cfg);
      storeToken("other-tab", 900_000);
      return res;
    };

    const res = await client.get("/x");

    expect(res.status).toBe(200);
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(sent).toEqual(["Bearer tok", "Bearer other-tab"]);
  });

  it("rejects when the retry is a 401 too, without renewing again", async () => {
    storeToken("tok", 900_000);
    markSignedIn();
    renewedTo("new");
    const { client, sent } = respond(401, 401);

    await expect(client.get("/x")).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
  });

  it("clears the tokens on a 401 without a session", async () => {
    storeToken("tok", 900_000);
    localStorage.setItem(config.keys.loggedOut, JSON.stringify("1"));
    const { client } = respond(401);

    await expect(client.get("/x")).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(readTokens()).toBeNull();
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it("passes other errors through", async () => {
    storeToken("tok", 900_000);
    const { client } = respond(500);

    await expect(client.get("/x")).rejects.toMatchObject({
      response: { status: 500 },
    });
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it("sends no token from the open client", async () => {
    storeToken("tok", 900_000);
    const { open, sent } = respond(200);

    await open.get("/x");

    expect(sent).toEqual([undefined]);
  });
});
