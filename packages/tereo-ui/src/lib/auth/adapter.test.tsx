import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreAuthProvider, useAuth, useAxios } from "@/lib/auth";
import { renderHook, waitFor } from "@testing-library/react";
import axios, { type AxiosAdapter } from "axios";
import type { ReactNode } from "react";

const USERINFO = {
  sub: "u1",
  email: "ada@example.com",
  permissions: ["users.write"],
  org_id: "o2",
  organizations: [
    { id: "o1", name: "One", slug: "one", memberRole: "member" },
    { id: "o2", name: "Two", slug: "two", memberRole: "admin" },
  ],
};

const requests: string[] = [];
const originalAdapter = axios.defaults.adapter;

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <CoreAuthProvider>{children}</CoreAuthProvider>
  </QueryClientProvider>
);

beforeEach(() => {
  localStorage.clear();
  requests.length = 0;
  // Today's key: a browser signed in before the move stays signed in.
  localStorage.setItem(
    "tereo_tokens",
    JSON.stringify({
      access_token: "tok",
      token_type: "Bearer",
      expires_in: 900,
      scope: "openid",
      expiresAt: Date.now() + 900_000,
    })
  );
  const adapter: AxiosAdapter = async (config) => {
    requests.push(`${config.baseURL}${config.url}`);
    return {
      data: USERINFO,
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    };
  };
  axios.defaults.adapter = adapter;
});

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  localStorage.clear();
});

describe("core's auth adapter", () => {
  it("loads the user from userinfo with its organizations", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.user?.sub).toBe("u1"));
    expect(requests).toEqual([`${window.location.origin}/oauth/userinfo`]);
    expect(result.current.user?.organizations).toEqual(USERINFO.organizations);
    expect(result.current.organizations).toEqual(USERINFO.organizations);
    expect(result.current.currentOrganization?.name).toBe("Two");
    expect(result.current.isSocketConnected).toBe(false);
  });

  it("checks permissions through the hierarchy", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.user).not.toBeNull());
    expect(result.current.hasPermission("users.read")).toBe(true);
    expect(result.current.hasPermission("users.delete")).toBe(false);
  });

  it("points each service's client at its part of core", () => {
    const { result } = renderHook(() => useAxios("fileService"), { wrapper });

    expect(result.current.defaults.baseURL).toMatch(/\/v1\/files$/);
  });
});
