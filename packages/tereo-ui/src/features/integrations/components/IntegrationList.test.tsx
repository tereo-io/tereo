import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntegrationList } from "./IntegrationList";
import type { Integration } from "../api/types";
import { MemoryRouter } from "react-router-dom";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () => ({
  ...(await import("@/test/authMock")).mockAuthModule(),
  useAuth: () => ({ hasPermission: () => true }),
}));

const base: Integration = {
  id: "i1",
  slug: "acme-3pl",
  name: "Acme 3PL",
  organizationId: "o1",
  organization: { id: "o1", name: "Northwind", slug: "northwind" },
  isActive: true,
  provisioned: false,
  unprovisionedAt: null,
  clientId: "abc",
  serviceAccountUserId: null,
  serviceAccountUser: null,
  roles: [],
  audience: [],
  previousSecretExpiresAt: null,
  createdBy: "u1",
  creator: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

const rows: Integration[] = [
  base,
  {
    ...base,
    id: "i2",
    slug: "pay-hub",
    name: "Pay Hub",
    organizationId: null,
    organization: null,
    provisioned: true,
  },
];

beforeEach(() => {
  authMock.axios.get.mockReset();
  authMock.axios.get.mockResolvedValue({
    data: { data: rows, hasMore: false, limit: 25, nextCursor: null },
  });
});

describe("IntegrationList", () => {
  it("shows an org-bound integration's organization and marks a platform one", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <IntegrationList />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByText("Acme 3PL")).toBeVisible();
    expect(screen.getByText("Northwind")).toBeVisible();
    expect(screen.getByText("Platform")).toBeVisible();
    expect(screen.getByText("Managed by provisioning")).toBeVisible();
  });

  it("links each integration's name to its page", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <IntegrationList />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(
      await screen.findByRole("link", { name: "Acme 3PL" })
    ).toHaveAttribute("href", "/integrations/i1");
  });
});
