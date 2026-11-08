import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Group } from "../../api/groups/types";
import { GroupDetail } from "./GroupDetail";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const group: Group = {
  id: "g1",
  organizationId: null,
  slug: "support",
  name: "Support",
  description: null,
  definitionSource: "local",
  membershipSource: "local",
  unprovisionedAt: null,
  archivedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  memberCount: 1,
};

const members = [
  {
    userId: "u1",
    email: "ada@example.com",
    name: "Ada",
    isActive: true,
    addedAt: "2026-10-02T00:00:00Z",
  },
];

const roles = [
  { id: "r1", name: "agent", displayName: "Agent", serviceId: null },
];

const renderDetail = (data: Group) => {
  authMock.axios.get.mockImplementation(async (url: string) => {
    const path = String(url);
    if (path.endsWith("/members")) {
      return {
        data: { data: members, hasMore: false, limit: 50, nextCursor: null },
      };
    }
    if (path.endsWith("/roles"))
      return { data: { data: roles, nextCursor: null } };
    return { data };
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/groups/g1"]}>
        <Routes>
          <Route path="/groups/:groupId" element={<GroupDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  authMock.axios.get.mockReset();
  authMock.permissions = ["groups.read", "groups.write", "groups.archive"];
  authMock.organizations = [];
});

describe("GroupDetail", () => {
  it("lists the members, then the roles on the Roles tab", async () => {
    renderDetail(group);

    expect(await screen.findByText("ada@example.com")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /^Roles/ }));
    expect(await screen.findByText("Agent")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit roles" })).toBeEnabled();
  });

  it("locks a provisioned group's fields, roles and archive but not its members", async () => {
    renderDetail({ ...group, definitionSource: "provisioned" });

    expect(await screen.findByText("Managed by provisioning")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Archive" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add members" })).toBeEnabled();
    expect(await screen.findByTitle("Remove")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: /^Roles/ }));
    expect(
      await screen.findByRole("button", { name: "Edit roles" })
    ).toBeDisabled();
  });

  it("offers no write controls without groups.write", async () => {
    authMock.permissions = ["groups.read"];
    renderDetail(group);

    await screen.findByText("ada@example.com");
    expect(screen.queryByRole("button", { name: "Add members" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByTitle("Remove")).toBeNull();
  });

  it("lets an organization admin manage its group without groups.*", async () => {
    authMock.permissions = [];
    authMock.organizations = [
      { id: "o1", name: "Acme", slug: "acme", memberRole: "admin" },
    ];
    renderDetail({ ...group, organizationId: "o1" });

    expect(
      await screen.findByRole("button", { name: "Add members" })
    ).toBeEnabled();
  });

  it("freezes an archived group", async () => {
    renderDetail({ ...group, archivedAt: "2026-10-05T00:00:00Z" });

    expect(await screen.findByTitle("Restore")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add members" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  });
});
