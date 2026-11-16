import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TereoAuthConfig, setActiveConfig } from "../config.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { TereoAuthProvider } from "../provider.js";
import { useAuth } from "../hooks.js";

type Listener = (...args: unknown[]) => void;

const { io, refreshTokens, signOut } = vi.hoisted(() => ({
  io: vi.fn(),
  refreshTokens: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("socket.io-client", () => ({ io }));
vi.mock("../refresh.js", () => ({ refreshTokens }));
vi.mock("../signOut.js", () => ({ signOut }));

class FakeSocket {
  active = false;
  connect = vi.fn();
  disconnect = vi.fn();
  listeners = new Map<string, Listener[]>();
  on(event: string, l: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), l]);
  }
  emit(event: string, ...args: unknown[]) {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

const TOKENS_KEY = "tereo_app_tokens";
const loadUser = vi.fn();
let sockets: FakeSocket[] = [];

const b64 = (o: object) =>
  btoa(JSON.stringify(o))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const jwt = (claims: object) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;

const storeTokens = (claims: object = { sub: "u1", sid: "s1" }) =>
  localStorage.setItem(
    TOKENS_KEY,
    JSON.stringify({
      access_token: jwt(claims),
      token_type: "Bearer",
      expires_in: 900,
      scope: "openid",
      expiresAt: Date.now() + 900_000,
    })
  );

const config = (over: Partial<TereoAuthConfig> = {}): TereoAuthConfig => ({
  coreUrl: "https://core.example.com/some/path",
  clientId: "app",
  redirectUri: "https://app.example.com/callback",
  apis: { main: "https://api.example.com" },
  loadUser,
  ...over,
});

const render = (c: TereoAuthConfig, strict = false) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(() => useAuth(), {
    wrapper: ({ children }: { children: ReactNode }) => {
      const tree = (
        <QueryClientProvider client={client}>
          <TereoAuthProvider config={c}>{children}</TereoAuthProvider>
        </QueryClientProvider>
      );
      return strict ? <StrictMode>{tree}</StrictMode> : tree;
    },
  });
};

const socket = () => sockets[sockets.length - 1];
const waitForSocket = () => waitFor(() => expect(socket()).toBeDefined());

beforeEach(() => {
  localStorage.clear();
  sockets = [];
  io.mockReset();
  io.mockImplementation(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  });
  loadUser.mockReset();
  loadUser.mockResolvedValue({ permissions: [] });
  refreshTokens.mockReset();
  signOut.mockReset();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { pathname: "/", href: "" },
  });
});

afterEach(() => {
  setActiveConfig(null);
  vi.useRealTimers();
});

describe("TereoAuthProvider live events", () => {
  it("opens the socket on core's origin and path, without autoConnect", async () => {
    storeTokens();
    render(config());
    await waitForSocket();
    expect(io).toHaveBeenCalledWith(
      "https://core.example.com",
      expect.objectContaining({
        path: "/ws",
        transports: ["websocket", "polling"],
        autoConnect: false,
      })
    );
    await waitFor(() => expect(socket().connect).toHaveBeenCalled());
  });

  it("opens no socket when live is false", async () => {
    storeTokens();
    const { result } = render(config({ live: false }));
    await waitFor(() => expect(result.current.user).not.toBeNull());
    expect(io).not.toHaveBeenCalled();
  });

  it("opens no socket without a signed-in user", async () => {
    render(config());
    await Promise.resolve();
    expect(io).not.toHaveBeenCalled();
  });

  it("follows the socket's connection in isLive", async () => {
    storeTokens();
    const { result } = render(config());
    await waitForSocket();
    expect(result.current.isLive).toBe(false);
    act(() => socket().emit("connect"));
    expect(result.current.isLive).toBe(true);
    act(() => socket().emit("disconnect", "transport close"));
    expect(result.current.isLive).toBe(false);
    act(() => socket().emit("connect"));
    act(() => socket().emit("connect_error", new Error("x")));
    expect(result.current.isLive).toBe(false);
  });

  it("reloads the user once for a burst of events and passes each to onEvent", async () => {
    storeTokens();
    const onEvent = vi.fn();
    const { result } = render(config({ onEvent }));
    await waitFor(() => expect(result.current.user).not.toBeNull());
    await waitForSocket();
    expect(loadUser).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    act(() => {
      socket().emit("auth:organization:changed", { reason: "m", timestamp: 1 });
      socket().emit("auth:permissions:changed", { reason: "r", timestamp: 2 });
    });
    expect(onEvent).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(249));
    expect(loadUser).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(2));
    expect(loadUser).toHaveBeenCalledTimes(2);
  });

  it("signs out only for its own session's revocation", async () => {
    storeTokens();
    const onEvent = vi.fn();
    render(config({ onEvent }));
    await waitForSocket();
    act(() =>
      socket().emit("auth:session:revoked", {
        sessionId: "other",
        timestamp: 1,
      })
    );
    expect(signOut).not.toHaveBeenCalled();
    act(() =>
      socket().emit("auth:session:revoked", { sessionId: "s1", timestamp: 2 })
    );
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it("keeps one socket across token rotation and closes it on sign-out", async () => {
    storeTokens();
    render(config());
    await waitForSocket();
    act(() => storeTokens({ sub: "u1", sid: "s2" }));
    await act(async () => {});
    expect(io).toHaveBeenCalledTimes(1);
    expect(socket().disconnect).not.toHaveBeenCalled();

    act(() => {
      localStorage.removeItem(TOKENS_KEY);
      window.dispatchEvent(new StorageEvent("storage", { key: TOKENS_KEY }));
    });
    await waitFor(() => expect(socket().disconnect).toHaveBeenCalled());
  });

  it("keeps reloadUser's identity across renders", async () => {
    storeTokens();
    const { result, rerender } = render(config());
    await waitFor(() => expect(result.current.user).not.toBeNull());
    const first = result.current.reloadUser;
    rerender();
    act(() => socket()?.emit("connect"));
    expect(result.current.reloadUser).toBe(first);
  });

  it("creates a single socket under StrictMode", async () => {
    storeTokens();
    render(config(), true);
    await waitForSocket();
    await act(async () => {});
    expect(io).toHaveBeenCalledTimes(1);
  });
});
