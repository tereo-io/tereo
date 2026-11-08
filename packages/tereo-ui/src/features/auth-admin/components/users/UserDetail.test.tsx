import type { UserDetail as UserDetailData } from "../../api/users/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import useUpdateSettings from "../../api/settings/useUpdateSettings";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMock } from "@/test/authMock";
import { UserDetail } from "./UserDetail";
import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";

const denied = vi.hoisted(() => new Set<string>());

vi.mock("@/lib/auth", async () => ({
  ...(await import("@/test/authMock")).mockAuthModule(),
  useAuth: () => ({ hasPermission: (p: string) => !denied.has(p) }),
  useLogout: () => vi.fn(),
}));

const person: UserDetailData = {
  id: "u1",
  email: "ada@example.com",
  name: "Ada",
  isActive: true,
  userType: "human",
  hasPassword: true,
  emailVerified: true,
  emailVerifiedAt: "2026-10-01T00:00:00Z",
  expiresAt: null,
  status: "active",
  passwordChangeRequired: false,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  managedBy: null,
  rateLimitPerSecond: null,
};

const account: UserDetailData = {
  ...person,
  email: "billing@services.example.com",
  userType: "service_account",
};

const renderDetail = (
  user: UserDetailData,
  client: QueryClient = new QueryClient(),
  settings: object = { rateLimits: { preAuthPerSecond: 300 } }
) => {
  authMock.axios.get.mockImplementation(async (path: string) => {
    const url = String(path);
    if (url.endsWith("/roles")) return { data: { roles: [] } };
    if (url.endsWith("/permissions")) return { data: { permissions: [] } };
    if (url.endsWith("/sessions")) return { data: { sessions: [] } };
    if (url.endsWith("/totp")) return { data: { totpEnabled: false } };
    if (url.endsWith("/identities"))
      return { data: { identities: [], invites: [] } };
    if (url.endsWith("/identity-providers")) return { data: { data: [] } };
    if (url.endsWith("/settings")) return { data: settings };
    return { data: user };
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/users/u1"]}>
        <Routes>
          <Route path="/users/:userId" element={<UserDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  authMock.axios.get.mockReset();
  authMock.axios.patch.mockReset();
  denied.clear();
});

const settingsCalls = () =>
  authMock.axios.get.mock.calls.filter(([path]) =>
    String(path).endsWith("/settings")
  );

describe("UserDetail", () => {
  it("shows Unverified and sends a verification email", async () => {
    authMock.axios.post.mockReset();
    authMock.axios.post.mockResolvedValue({ data: undefined });
    renderDetail({ ...person, emailVerified: false, emailVerifiedAt: null });

    expect(await screen.findByText("Unverified")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Send verification email" })
    );
    await waitFor(() =>
      expect(authMock.axios.post).toHaveBeenCalledWith(
        "/v1/admin/users/u1/email-verification"
      )
    );
  });

  it("shows Verified without the send button", async () => {
    renderDetail(person);

    expect(await screen.findByText("Verified")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Send verification email" })
    ).toBeNull();
  });

  it("offers Edit and Manage Roles for a person", async () => {
    renderDetail(person);

    await screen.findByText("User Details");
    expect(screen.getByTitle("Edit")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage Roles" })).toBeVisible();
  });

  it.each([
    ["the system user", { ...account, managedBy: { kind: "system" } }],
    [
      "a service's account",
      {
        ...account,
        managedBy: { kind: "service", id: "s1", name: "Billing" },
      },
    ],
  ] as [string, UserDetailData][])(
    "hides Edit and Manage Roles for %s",
    async (_case, user) => {
      renderDetail(user);

      await screen.findByText("User Details");
      expect(screen.queryByTitle("Edit")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Manage Roles" })
      ).not.toBeInTheDocument();
    }
  );

  describe("a guest", () => {
    const guest: UserDetailData = {
      ...person,
      userType: "guest",
      expiresAt: "2026-12-01T00:00:00Z",
    };

    it("offers Extend, Promote and Send password link", async () => {
      renderDetail(guest);

      await screen.findByText("User Details");
      expect(screen.getByRole("button", { name: "Extend" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Promote" })).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Send password link" })
      ).toBeVisible();
      expect(screen.getByText("Guest")).toBeVisible();
    });

    it("hides all three without users.guests.write", async () => {
      denied.add("users.guests.write");
      renderDetail(guest);

      await screen.findByText("User Details");
      expect(screen.queryByRole("button", { name: "Extend" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Promote" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Send password link" })
      ).toBeNull();
    });

    it("hides Promote without users.write", async () => {
      denied.add("users.write");
      renderDetail(guest);

      await screen.findByText("User Details");
      expect(screen.getByRole("button", { name: "Extend" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Promote" })).toBeNull();
    });

    it("shows an expired guest as Expired", async () => {
      renderDetail({ ...guest, status: "expired" });

      expect(await screen.findByText("Expired")).toBeVisible();
    });
  });

  it("offers no guest actions for a person", async () => {
    renderDetail(person);

    await screen.findByText("User Details");
    expect(screen.queryByRole("button", { name: "Extend" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Promote" })).toBeNull();
  });

  it("says core manages the system user", async () => {
    renderDetail({ ...account, managedBy: { kind: "system" } });

    expect(await screen.findByText(/Core manages it/)).toBeVisible();
  });

  it.each([
    ["service", "/services/s1"],
    ["integration", "/integrations/s1"],
  ] as const)("links a %s's account to its owner", async (kind, href) => {
    renderDetail({
      ...account,
      managedBy: { kind, id: "s1", name: "Billing" },
    });

    expect(
      await screen.findByRole("link", { name: "Billing" })
    ).toHaveAttribute("href", href);
  });

  it("renders after a settings save whose response has no rate limits", async () => {
    const client = new QueryClient();
    authMock.axios.patch.mockResolvedValue({
      data: { totpPolicy: "optional", totpRecoveryCodeCount: 10 },
    });
    const { result } = renderHook(() => useUpdateSettings(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await result.current.mutateAsync({ totpRecoveryCodeCount: 10 });

    renderDetail({ ...person, rateLimitPerSecond: 400 }, client, {
      totpPolicy: "optional",
      totpRecoveryCodeCount: 10,
    });

    expect(await screen.findByText("User Details")).toBeVisible();
  });

  describe("rate limit", () => {
    const field = () => screen.getByLabelText("Rate limit (requests/second)");

    it("saves a new limit for a person", async () => {
      authMock.axios.patch.mockResolvedValue({ data: person });
      renderDetail(person);

      await screen.findByText("User Details");
      fireEvent.change(field(), { target: { value: "250" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(authMock.axios.patch).toHaveBeenCalledWith(
          "/v1/admin/users/u1",
          { rateLimitPerSecond: 250 }
        )
      );
    });

    it("warns above the pre-sign-in limit when settings are readable", async () => {
      renderDetail({ ...person, rateLimitPerSecond: 400 });

      expect(
        await screen.findByText(/Above the per-IP limit of 300\/s/)
      ).toBeVisible();
    });

    it("leaves the warning out and skips settings without settings.read", async () => {
      denied.add("settings.read");
      renderDetail({ ...person, rateLimitPerSecond: 400 });

      await screen.findByText("User Details");
      expect(field()).toHaveValue("400");
      expect(
        screen.queryByText(/Above the per-IP limit/)
      ).not.toBeInTheDocument();
      expect(settingsCalls()).toHaveLength(0);
    });

    it("is read-only for a managed account", async () => {
      renderDetail({
        ...account,
        rateLimitPerSecond: 50,
        managedBy: { kind: "system" },
      });

      await screen.findByText("User Details");
      expect(
        screen.queryByLabelText("Rate limit (requests/second)")
      ).toBeNull();
      expect(screen.getByText("50")).toBeVisible();
    });
  });
});
