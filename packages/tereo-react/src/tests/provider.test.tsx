import { useApi, useAuth, useCompleteSignIn, usePublicApi } from "../hooks.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TereoAuthConfig, setActiveConfig } from "../config.js";
import { AxiosError, type AxiosResponse } from "axios";
import { StrictMode, type ReactNode } from "react";
import { TereoAuthProvider } from "../provider.js";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";

const { signIn, completeSignIn, refreshTokens } = vi.hoisted(() => ({
  signIn: vi.fn(),
  completeSignIn: vi.fn(),
  refreshTokens: vi.fn(),
}));
vi.mock("../signIn.js", () => ({ signIn, completeSignIn }));
vi.mock("../refresh.js", () => ({ refreshTokens }));

const TOKENS_KEY = "tereo_app_tokens";
const loadUser = vi.fn();

const httpError = (status: number) =>
  new AxiosError("failed", undefined, undefined, undefined, {
    status,
  } as AxiosResponse);

const baseConfig = (over: Partial<TereoAuthConfig> = {}): TereoAuthConfig => ({
  coreUrl: "https://core.example.com",
  clientId: "app",
  redirectUri: "https://app.example.com/callback",
  apis: { main: "https://api.example.com" },
  loadUser,
  basePath: "/ui",
  signedOutPath: "/signed-out",
  ...over,
});

const jwt = (claims: Record<string, unknown>) =>
  `h.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.s`;

const storeTokens = (accessToken = "tok") =>
  localStorage.setItem(
    TOKENS_KEY,
    JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 900,
      scope: "openid",
      expiresAt: Date.now() + 900_000,
    })
  );

let href = "";
const at = (pathname: string) => {
  href = "";
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      pathname,
      get href() {
        return href;
      },
      set href(v: string) {
        href = v;
      },
    },
  });
};

const wrapperFor =
  (config: TereoAuthConfig) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TereoAuthProvider config={config}>{children}</TereoAuthProvider>
    </QueryClientProvider>
  );

beforeEach(() => {
  localStorage.clear();
  loadUser.mockReset();
  signIn.mockReset();
  completeSignIn.mockReset();
  refreshTokens.mockReset();
  at("/ui/dashboard");
});

afterEach(() => {
  setActiveConfig(null);
  vi.useRealTimers();
});

describe("TereoAuthProvider", () => {
  it("loads the user with the authed clients once tokens exist", async () => {
    storeTokens();
    loadUser.mockResolvedValue({ permissions: ["files.read"], name: "Ada" });

    const { result } = renderHook(() => useAuth(), {
      wrapper: wrapperFor(baseConfig()),
    });

    await waitFor(() => expect(result.current.user).not.toBeNull());
    expect(result.current.user).toMatchObject({ name: "Ada" });
    expect(result.current.isSignedIn).toBe(true);
    expect(result.current.isLive).toBe(false);
    const clients = loadUser.mock.calls[0][0];
    expect(Object.keys(clients)).toEqual(["main"]);
    expect(clients.main.defaults.baseURL).toBe("https://api.example.com");
  });

  it("retries a failed user lookup with backoff", async () => {
    vi.useFakeTimers();
    storeTokens();
    loadUser
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValue({ permissions: [], name: "Ada" });

    const { result } = renderHook(() => useAuth(), {
      wrapper: wrapperFor(baseConfig()),
    });

    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(loadUser).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(loadUser).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(result.current.user).toMatchObject({ name: "Ada" });
  });

  it("gives up on the user lookup after two retries", async () => {
    vi.useFakeTimers();
    storeTokens();
    loadUser.mockRejectedValue(httpError(503));

    renderHook(() => useAuth(), { wrapper: wrapperFor(baseConfig()) });

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(loadUser).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403])(
    "does not retry a user lookup core answered with %i",
    async (status) => {
      vi.useFakeTimers();
      storeTokens();
      loadUser.mockRejectedValue(httpError(status));

      const { result } = renderHook(() => useAuth(), {
        wrapper: wrapperFor(baseConfig()),
      });

      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(loadUser).toHaveBeenCalledTimes(1);
      expect(result.current.user).toBeNull();
    }
  );

  it("does not load the user without tokens", () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: wrapperFor(baseConfig()),
    });

    expect(loadUser).not.toHaveBeenCalled();
    expect(result.current.user).toBeNull();
    expect(result.current.isSignedIn).toBe(false);
  });

  it("checks permissions on the ladder", async () => {
    storeTokens();
    loadUser.mockResolvedValue({ permissions: ["files.write"] });
    const { result } = renderHook(() => useAuth(), {
      wrapper: wrapperFor(baseConfig()),
    });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    expect(result.current.hasPermission("files.read")).toBe(true);
    expect(result.current.hasPermission("files.write")).toBe(true);
    expect(result.current.hasPermission("files.delete")).toBe(false);
    expect(result.current.hasPermission(["files.delete", "files.read"])).toBe(
      true
    );
  });

  it("navigates a visitor without a session off a private path", () => {
    at("/ui/dashboard");
    renderHook(() => useAuth(), { wrapper: wrapperFor(baseConfig()) });
    expect(href).toBe("/ui/signed-out");
  });

  it.each(["/ui/signed-out", "/ui/callback"])(
    "leaves a visitor without a session on the public path %s",
    (path) => {
      at(path);
      renderHook(() => useAuth(), { wrapper: wrapperFor(baseConfig()) });
      expect(href).toBe("");
    }
  );

  it("does not navigate a signed-in user", async () => {
    storeTokens();
    loadUser.mockResolvedValue({ permissions: [] });
    const { result } = renderHook(() => useAuth(), {
      wrapper: wrapperFor(baseConfig()),
    });
    await waitFor(() => expect(result.current.user).not.toBeNull());
    expect(href).toBe("");
  });

  it("renews a missing token when a session marker exists, before redirecting", async () => {
    localStorage.setItem("tereo_app_signed_in", JSON.stringify("1"));
    let renewed!: () => void;
    refreshTokens.mockReturnValue(
      new Promise<void>((resolve) => (renewed = resolve))
    );
    const { result } = renderHook(() => useAuth(), {
      wrapper: wrapperFor(baseConfig()),
    });

    expect(result.current.isLoading).toBe(true);
    expect(href).toBe("");
    await act(async () => renewed());
    expect(result.current.isLoading).toBe(false);
  });

  it("switchOrganization signs in with the organization", async () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: wrapperFor(baseConfig()),
    });

    await result.current.switchOrganization("o1");

    expect(signIn).toHaveBeenCalledWith({ params: { org_id: "o1" } });
  });

  it("reloadUser loads the user again", async () => {
    storeTokens();
    loadUser.mockResolvedValueOnce({ permissions: [], v: 1 });
    loadUser.mockResolvedValueOnce({ permissions: [], v: 2 });
    const { result } = renderHook(() => useAuth(), {
      wrapper: wrapperFor(baseConfig()),
    });
    await waitFor(() => expect(result.current.user).toMatchObject({ v: 1 }));

    await act(() => result.current.reloadUser());

    await waitFor(() => expect(result.current.user).toMatchObject({ v: 2 }));
  });

  it("reloads the user when another tab signs in to another organization", async () => {
    storeTokens(jwt({ sub: "u1", org_id: "a" }));
    loadUser.mockImplementation(async () => ({
      permissions: [],
      org: JSON.parse(localStorage.getItem(TOKENS_KEY)!).access_token,
    }));
    const { result } = renderHook(() => useAuth(), {
      wrapper: wrapperFor(baseConfig()),
    });
    await waitFor(() => expect(result.current.user).not.toBeNull());
    expect(loadUser).toHaveBeenCalledTimes(1);

    const orgB = jwt({ sub: "u1", org_id: "b" });
    act(() => {
      storeTokens(orgB);
      window.dispatchEvent(new StorageEvent("storage", { key: TOKENS_KEY }));
    });

    await waitFor(() =>
      expect(result.current.user).toMatchObject({ org: orgB })
    );
    expect(loadUser).toHaveBeenCalledTimes(2);
  });

  it("does not show the previous identity's user while the new one loads", async () => {
    storeTokens(jwt({ sub: "u1", org_id: "a" }));
    loadUser.mockResolvedValueOnce({ permissions: [], name: "Ada" });
    const { result } = renderHook(() => useAuth(), {
      wrapper: wrapperFor(baseConfig()),
    });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    loadUser.mockReturnValueOnce(new Promise(() => {}));
    act(() => {
      storeTokens(jwt({ sub: "u2", org_id: "a" }));
      window.dispatchEvent(new StorageEvent("storage", { key: TOKENS_KEY }));
    });

    await waitFor(() => expect(loadUser).toHaveBeenCalledTimes(2));
    expect(result.current.user).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it("reloads the user once when its token is refreshed", async () => {
    storeTokens(jwt({ sub: "u1", org_id: "a", jti: "1" }));
    loadUser
      .mockResolvedValueOnce({ permissions: [], v: 1 })
      .mockResolvedValueOnce({ permissions: [], v: 2 });
    const { result } = renderHook(() => useAuth(), {
      wrapper: wrapperFor(baseConfig()),
    });
    await waitFor(() => expect(result.current.user).toMatchObject({ v: 1 }));

    act(() => {
      storeTokens(jwt({ sub: "u1", org_id: "a", jti: "2" }));
      window.dispatchEvent(new StorageEvent("storage", { key: TOKENS_KEY }));
    });

    await waitFor(() => expect(result.current.user).toMatchObject({ v: 2 }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(loadUser).toHaveBeenCalledTimes(2);
  });

  it("drops the user when another tab signs out", async () => {
    storeTokens();
    loadUser.mockResolvedValue({ permissions: [] });
    const { result } = renderHook(() => useAuth(), {
      wrapper: wrapperFor(baseConfig()),
    });
    await waitFor(() => expect(result.current.user).not.toBeNull());

    act(() => {
      localStorage.removeItem(TOKENS_KEY);
      window.dispatchEvent(new StorageEvent("storage", { key: TOKENS_KEY }));
    });

    await waitFor(() => expect(result.current.user).toBeNull());
    expect(result.current.isSignedIn).toBe(false);
  });
});

describe("hooks", () => {
  it("useApi and usePublicApi return the named client and throw on an unknown name", () => {
    const wrapper = wrapperFor(baseConfig());
    const { result } = renderHook(
      () => ({ authed: useApi("main"), open: usePublicApi("main") }),
      { wrapper }
    );
    expect(result.current.authed).not.toBe(result.current.open);
    expect(result.current.authed.defaults.baseURL).toBe(
      "https://api.example.com"
    );

    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useApi("nope"), { wrapper })).toThrow(
      'No API named "nope"'
    );
    expect(() => renderHook(() => usePublicApi("nope"), { wrapper })).toThrow(
      'No API named "nope"'
    );
    vi.restoreAllMocks();
  });

  it("useAuth throws outside the provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useAuth())).toThrow("TereoAuthProvider");
    vi.restoreAllMocks();
  });

  it("useCompleteSignIn exchanges once per mount under StrictMode", async () => {
    completeSignIn.mockResolvedValue({ returnTo: "/files" });
    const search = new URLSearchParams("code=c&state=s");
    const seen: unknown[] = [];

    const Callback = () => {
      const { complete, isPending } = useCompleteSignIn();
      return (
        <button
          onClick={() => {
            void complete(search).then((r) => seen.push(r));
            void complete(search).then((r) => seen.push(r));
          }}
        >
          {isPending ? "pending" : "idle"}
        </button>
      );
    };
    render(
      <StrictMode>
        <Callback />
      </StrictMode>
    );

    await act(async () => screen.getByRole("button").click());

    expect(completeSignIn).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ returnTo: "/files" }, { returnTo: "/files" }]);
  });

  it("useCompleteSignIn exposes the failure", async () => {
    completeSignIn.mockRejectedValue(new Error("access_denied"));
    const { result } = renderHook(() => useCompleteSignIn());

    await act(async () => {
      await result.current.complete(new URLSearchParams()).catch(() => {});
    });

    expect(result.current.error?.message).toBe("access_denied");
    expect(result.current.isPending).toBe(false);
  });
});
