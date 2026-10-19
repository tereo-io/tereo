import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Role } from "../../api/roles/types";
import { authMock } from "@/test/authMock";
import { RoleDetail } from "./RoleDetail";

vi.mock("@/lib/auth", async () => ({
  ...(await import("@/test/authMock")).mockAuthModule(),
  useAuth: () => ({ hasPermission: () => true }),
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

const renderDetail = (data: Role) => {
  authMock.axios.get.mockImplementation(async (url: string) => ({
    data: String(url).endsWith("/users") ? { roleId: "r1", users } : data,
  }));
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

beforeEach(() => authMock.axios.get.mockReset());

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
});
