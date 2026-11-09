import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Role } from "../../api/roles/types";
import { authMock } from "@/test/authMock";
import { RoleDetail } from "./RoleDetail";

const granted = vi.hoisted(() => ({ all: true }));

vi.mock("@/lib/auth", async () => ({
  ...(await import("@/test/authMock")).mockAuthModule(),
  useAuth: () => ({
    hasPermission: (p: string) => granted.all || !p.startsWith("groups."),
    organizations: [],
  }),
}));

const role: Role = {
  id: "r1",
  name: "support",
  displayName: "Support",
  description: null,
  isSystem: false,
  serviceId: null,
  service: null,
  isActive: false,
  archivedAt: null,
  retiredAt: null,
  requires2fa: false,
  guestAssignable: false,
  provisioned: false,
  unprovisionedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  permissions: [],
};

const users = [
  {
    id: "u1",
    email: "ada@example.com",
    name: "Ada",
    isActive: true,
    organizationId: null,
    organization: null,
    expiresAt: null,
  },
];

const groups = [
  {
    id: "g1",
    slug: "helpdesk",
    name: "Helpdesk",
    organizationId: null,
    organization: null,
    memberCount: 4,
  },
  {
    id: "g2",
    slug: "acme-support",
    name: "Acme support",
    organizationId: "o1",
    organization: { id: "o1", name: "Acme", slug: "acme" },
    memberCount: 2,
  },
];

const renderDetail = (
  data: Role,
  rows: object[] = users,
  heldBy: object[] = []
) => {
  authMock.axios.get.mockImplementation(async (url: string) => {
    const path = String(url);
    if (path.endsWith("/users")) {
      return { data: { roleId: "r1", users: rows, groups: heldBy } };
    }
    return { data };
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/roles/r1"]}>
        <Routes>
          <Route path="/roles/:roleId" element={<RoleDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  authMock.axios.get.mockReset();
  granted.all = true;
});

describe("RoleDetail", () => {
  it("offers edit, archive and delete on a hand-made role", async () => {
    renderDetail(role);

    await screen.findByText("Role Details");
    expect(screen.getByTitle("Edit")).toBeInTheDocument();
    expect(screen.getByTitle("Archive")).toBeInTheDocument();
    expect(screen.getByTitle("Delete")).toBeInTheDocument();
    expect(
      screen.queryByText("Managed by provisioning")
    ).not.toBeInTheDocument();
  });

  it("badges a provisioned role and hides its edit, delete and permission controls", async () => {
    renderDetail({ ...role, provisioned: true });

    expect(await screen.findByText("Managed by provisioning")).toBeVisible();
    expect(screen.queryByTitle("Edit")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Archive")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Delete")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /permissions/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByTitle(/permissions/i)).not.toBeInTheDocument();
  });

  it("keeps user assignment controls on a provisioned role", async () => {
    renderDetail({ ...role, provisioned: true });

    expect(await screen.findByText("ada@example.com")).toBeVisible();
    expect(screen.getByTitle(/remove/i)).toBeInTheDocument();
  });

  it("lists the groups holding the role, with member counts and links", async () => {
    renderDetail(role, users, groups);

    expect(await screen.findByText("Groups with this Role (2)")).toBeVisible();
    expect(screen.getByRole("link", { name: "Helpdesk" })).toHaveAttribute(
      "href",
      "/auth-admin/groups/g1"
    );
    expect(screen.getByText("4")).toBeVisible();
    expect(screen.getByRole("link", { name: "Acme" })).toHaveAttribute(
      "href",
      "/auth-admin/organizations/o1"
    );
    // The users table holds direct assignments only, each removable.
    expect(screen.getByText("Users with this Role (1)")).toBeVisible();
    expect(screen.getAllByTitle(/remove/i)).toHaveLength(1);
  });

  it("names a group without a link when the viewer cannot open it", async () => {
    granted.all = false;
    renderDetail(role, users, groups);

    expect(await screen.findByText("Helpdesk")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Helpdesk" })).toBeNull();
  });
});
