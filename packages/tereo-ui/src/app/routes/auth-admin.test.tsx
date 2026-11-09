import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { authAdminRoute } from "./auth-admin";
import { authMock } from "@/test/authMock";
import type { ReactNode } from "react";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const group = {
  id: "g1",
  organizationId: "o1",
  slug: "support",
  name: "Support",
  description: null,
  definitionSource: "local",
  membershipSource: "local",
  unprovisionedAt: null,
  archivedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  memberCount: 0,
};

const groupPage = authAdminRoute.children!.find(
  (r) => r.path === "groups/:groupId"
)!.element as ReactNode;

const renderGroupPage = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/auth-admin/groups/g1"]}>
        <Routes>
          <Route path="/auth-admin/groups/:groupId" element={groupPage} />
          <Route path="/account" element={<p>Account page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  authMock.permissions = [];
  authMock.organizations = [];
  authMock.axios.get.mockReset();
  authMock.axios.get.mockImplementation(async (url: string) => {
    if (String(url).endsWith("/members")) {
      return {
        data: { data: [], hasMore: false, limit: 50, nextCursor: null },
      };
    }
    if (String(url).endsWith("/roles")) {
      return { data: { data: [], nextCursor: null } };
    }
    return { data: group };
  });
});

describe("the group page route", () => {
  it("opens for an organization admin without groups.*", async () => {
    authMock.organizations = [
      { id: "o1", name: "Acme", slug: "acme", memberRole: "admin" },
    ];
    renderGroupPage();

    expect(
      await screen.findByRole("button", { name: "Add members" })
    ).toBeEnabled();
  });

  it("opens for groups.read", async () => {
    authMock.permissions = ["groups.read"];
    renderGroupPage();

    expect(await screen.findByText("Group Details")).toBeVisible();
  });

  it("sends a plain member without groups.read to their account", async () => {
    authMock.organizations = [
      { id: "o1", name: "Acme", slug: "acme", memberRole: "member" },
    ];
    renderGroupPage();

    expect(await screen.findByText("Account page")).toBeVisible();
  });
});
