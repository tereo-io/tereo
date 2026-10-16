import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WebhookEndpointDetail } from "./WebhookEndpointDetail";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WebhookEndpoint } from "../../api/types";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () => ({
  ...(await import("@/test/authMock")).mockAuthModule(),
  useAuth: () => ({
    hasPermission: () => true,
    currentOrganization: { id: "o1" },
  }),
}));

const endpoint: WebhookEndpoint = {
  id: "w1",
  organizationId: "o1",
  url: "https://billing.example.com/hook",
  description: "Billing hook",
  signingSecret: "whsec_ab...",
  status: "ACTIVE",
  customHeaders: null,
  consecutiveFailures: 0,
  archivedAt: null,
  previousSecretExpiresAt: null,
  hasDeliveries: false,
  provisioned: false,
  ownerService: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  createdBy: "u1",
  creator: { id: "u1", email: "a@example.com", name: null },
  eventTypes: ["files.created"],
  retiredEventTypes: [],
};

const owned: WebhookEndpoint = {
  ...endpoint,
  organizationId: null,
  provisioned: true,
  ownerService: { id: "s1", slug: "billing", name: "Billing" },
};

const renderDetail = (data: WebhookEndpoint) => {
  authMock.axios.get.mockImplementation(async (url: string) => ({
    data: String(url).endsWith("/stats") ? undefined : data,
  }));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/webhooks/endpoints/w1"]}>
        <Routes>
          <Route
            path="/webhooks/endpoints/:endpointId"
            element={<WebhookEndpointDetail />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

beforeEach(() => authMock.axios.get.mockReset());

describe("WebhookEndpointDetail", () => {
  it("offers every control on a hand-made endpoint", async () => {
    renderDetail(endpoint);

    await screen.findByText("Endpoint Details");
    expect(screen.getByTitle("Edit")).toBeInTheDocument();
    expect(screen.getByTitle("Archive")).toBeInTheDocument();
    expect(screen.getByTitle("Delete")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Rotate Secret" })
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Managed by provisioning")
    ).not.toBeInTheDocument();
  });

  it("shows an owned endpoint's service and scope and hides its changes", async () => {
    renderDetail(owned);

    expect(await screen.findByText("Managed by provisioning")).toBeVisible();
    expect(screen.getByRole("link", { name: "Billing" })).toHaveAttribute(
      "href",
      "/services/s1"
    );
    expect(screen.getByText("All organizations")).toBeVisible();
    expect(screen.queryByTitle("Edit")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Archive")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Delete")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Rotate Secret" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send Test" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Deliveries" })
    ).toBeInTheDocument();
  });

  it("lets an admin re-enable a disabled owned endpoint", async () => {
    renderDetail({ ...owned, status: "DISABLED" });

    expect(
      await screen.findByRole("button", { name: "Re-enable" })
    ).toBeEnabled();
  });

  it("offers no re-enable on an active owned endpoint", async () => {
    renderDetail(owned);

    await screen.findByText("Endpoint Details");
    expect(
      screen.queryByRole("button", { name: "Re-enable" })
    ).not.toBeInTheDocument();
  });
});
