import type { UserDetail as UserDetailData } from "../../api/users/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { authMock } from "@/test/authMock";
import { UserDetail } from "./UserDetail";

vi.mock("@/lib/auth", async () => ({
  ...(await import("@/test/authMock")).mockAuthModule(),
  useAuth: () => ({ hasPermission: () => true }),
  useLogout: () => vi.fn(),
}));

const person: UserDetailData = {
  id: "u1",
  email: "ada@example.com",
  name: "Ada",
  isActive: true,
  userType: "human",
  hasPassword: true,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  managedBy: null,
};

const account: UserDetailData = {
  ...person,
  email: "billing@services.example.com",
  userType: "service_account",
};

const renderDetail = (user: UserDetailData) => {
  authMock.axios.get.mockImplementation(async (path: string) => {
    const url = String(path);
    if (url.endsWith("/roles")) return { data: { roles: [] } };
    if (url.endsWith("/permissions")) return { data: { permissions: [] } };
    if (url.endsWith("/sessions")) return { data: { sessions: [] } };
    if (url.endsWith("/totp")) return { data: { totpEnabled: false } };
    if (url.endsWith("/identities"))
      return { data: { identities: [], invites: [] } };
    if (url.endsWith("/identity-providers")) return { data: { data: [] } };
    return { data: user };
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/users/u1"]}>
        <Routes>
          <Route path="/users/:userId" element={<UserDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

beforeEach(() => authMock.axios.get.mockReset());

describe("UserDetail", () => {
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
});
