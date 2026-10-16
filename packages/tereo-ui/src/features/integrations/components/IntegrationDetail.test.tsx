import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntegrationDetail } from "./IntegrationDetail";
import type { Integration } from "../api/types";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () => ({
  ...(await import("@/test/authMock")).mockAuthModule(),
  useAuth: () => ({ hasPermission: () => true }),
}));

const orgBound: Integration = {
  id: "i1",
  slug: "acme-3pl",
  name: "Acme 3PL",
  organizationId: "o1",
  organization: { id: "o1", name: "Northwind", slug: "northwind" },
  isActive: true,
  provisioned: false,
  clientId: "abc",
  serviceAccountUserId: null,
  serviceAccountUser: null,
  roles: [{ id: "r1", name: "picker", displayName: "Picker", system: false }],
  audience: ["files"],
  previousSecretExpiresAt: null,
  createdBy: "u1",
  creator: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

const platform: Integration = {
  ...orgBound,
  organizationId: null,
  organization: null,
};

const renderDetail = (data: Integration) => {
  authMock.axios.get.mockResolvedValue({ data });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/integrations/i1"]}>
        <Routes>
          <Route
            path="/integrations/:integrationId"
            element={<IntegrationDetail />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

beforeEach(() => authMock.axios.get.mockReset());

describe("IntegrationDetail", () => {
  it("offers every change on a hand-made org-bound integration, without the global-role warning", async () => {
    renderDetail(orgBound);

    expect(await screen.findByText("Northwind")).toBeVisible();
    for (const name of [
      "Rename",
      /regenerate/i,
      "Deactivate",
      "Edit Roles",
      "Edit Audiences",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(
      screen.queryByText(/not bound to an organization/i)
    ).not.toBeInTheDocument();
  });

  it("warns that a platform integration's roles are global", async () => {
    renderDetail(platform);

    expect(
      await screen.findByText(/not bound to an organization/i)
    ).toBeVisible();
    expect(screen.getByText("Platform")).toBeVisible();
  });

  it("hides every edit control on a provisioned integration", async () => {
    renderDetail({ ...platform, provisioned: true });

    expect(await screen.findByText("Managed by provisioning")).toBeVisible();
    for (const name of [
      "Rename",
      /regenerate/i,
      "Deactivate",
      "Edit Roles",
      "Edit Audiences",
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("lets an admin end a provisioned integration's secret overlap", async () => {
    renderDetail({
      ...orgBound,
      provisioned: true,
      previousSecretExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    expect(await screen.findByText("Two secrets work right now")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /end overlap/i })
    ).toBeInTheDocument();
  });
});
