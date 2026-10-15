import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ServiceDetail as ServiceDetailData } from "../api/types";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ServiceDetail } from "./ServiceDetail";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () => ({
  ...(await import("@/test/authMock")).mockAuthModule(),
  useAuth: () => ({ hasPermission: () => true }),
}));

const service: ServiceDetailData = {
  id: "s1",
  slug: "billing",
  name: "Billing",
  namespace: "billing",
  isActive: true,
  provisioned: false,
  clientId: "billing",
  serviceAccountUserId: null,
  serviceAccountUser: null,
  audience: [],
  previousSecretExpiresAt: null,
  declarationHash: null,
  declarationVersion: null,
  declaredAt: null,
  createdBy: null,
  creator: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  declared: { permissions: [], systemRoles: [], buckets: [], eventTypes: [] },
  access: [
    {
      id: "a1",
      serviceId: "s1",
      kind: "role",
      target: "file_user",
      status: "pending",
      requestedAt: "2026-10-01T00:00:00Z",
      decidedAt: null,
      decidedBy: null,
      decidedByEmail: null,
      decidedByName: null,
      approvedPermissions: null,
      pendingPermissions: null,
    },
  ],
  settings: { secretOverlapHours: 24, retirementGraceHours: 24 },
};

const renderDetail = (data: ServiceDetailData) => {
  authMock.axios.get.mockResolvedValue({ data });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/services/s1"]}>
        <Routes>
          <Route path="/services/:serviceId" element={<ServiceDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

beforeEach(() => authMock.axios.get.mockReset());

describe("ServiceDetail", () => {
  it("offers rename, regenerate and deactivate on a hand-made service", async () => {
    renderDetail(service);

    await screen.findByText("Service Details");
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /regenerate/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Deactivate" })
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Managed by provisioning")
    ).not.toBeInTheDocument();
  });

  it("badges a provisioned service, hides its changes and keeps access decisions", async () => {
    renderDetail({ ...service, provisioned: true });

    expect(await screen.findByText("Managed by provisioning")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Rename" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /regenerate/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Deactivate" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve/i })).toBeEnabled();
  });

  it("lets an admin end a provisioned service's secret overlap", async () => {
    renderDetail({
      ...service,
      provisioned: true,
      previousSecretExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    expect(await screen.findByText("Two secrets work right now")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /end overlap/i })
    ).toBeInTheDocument();
  });
});
