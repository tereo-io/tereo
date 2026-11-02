import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ServiceDetail as ServiceDetailData } from "../api/types";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  unprovisionedAt: null,
  clientId: "billing",
  serviceAccountUserId: null,
  serviceAccountUser: null,
  audience: [],
  rateLimitPerSecond: null,
  previousSecretExpiresAt: null,
  declarationHash: null,
  declarationVersion: "1.2.0",
  declaredAt: "2026-10-02T00:00:00Z",
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
      status: "approved",
      requestedAt: "2026-10-01T00:00:00Z",
      decidedAt: "2026-10-01T00:00:00Z",
      decidedBy: null,
      decidedByEmail: null,
      decidedByName: null,
      approvedPermissions: null,
    },
    {
      id: "a2",
      serviceId: "s1",
      kind: "audience",
      target: "files",
      status: "revoked",
      requestedAt: "2026-10-01T00:00:00Z",
      decidedAt: "2026-10-02T00:00:00Z",
      decidedBy: null,
      decidedByEmail: null,
      decidedByName: null,
      approvedPermissions: null,
    },
  ],
  settings: { secretOverlapHours: 24, retirementGraceHours: 24 },
};

const renderDetail = (data: ServiceDetailData) => {
  authMock.axios.get.mockImplementation(async (path: string) =>
    String(path).endsWith("/settings")
      ? { data: { rateLimits: { preAuthPerSecond: 300 } } }
      : { data }
  );
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

beforeEach(() => {
  authMock.axios.get.mockReset();
  authMock.axios.patch.mockReset();
});

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
    expect(screen.getByRole("button", { name: "Re-approve" })).toBeEnabled();
  });

  it("has no pending inbox and offers Re-approve only on a revoked row", async () => {
    renderDetail(service);

    await screen.findByText("Service Details");
    expect(screen.queryByText(/pending/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve" })
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Re-approve" })).toHaveLength(
      1
    );
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
  });

  it("shows the declared version", async () => {
    renderDetail(service);

    expect(await screen.findByText("1.2.0")).toBeVisible();
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

  describe("rate limit", () => {
    const label = "Rate limit (requests/second)";

    it("saves a new limit", async () => {
      authMock.axios.patch.mockResolvedValue({ data: service });
      renderDetail(service);

      fireEvent.change(await screen.findByLabelText(label), {
        target: { value: "250" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(authMock.axios.patch).toHaveBeenCalledWith(
          "/v1/admin/services/s1",
          { rateLimitPerSecond: 250 }
        )
      );
    });

    it("warns above the pre-sign-in limit", async () => {
      renderDetail({ ...service, rateLimitPerSecond: 400 });

      expect(
        await screen.findByText(/Above the per-IP limit of 300\/s/)
      ).toBeVisible();
    });

    it("shows a provisioned service's limit read-only", async () => {
      renderDetail({ ...service, provisioned: true, rateLimitPerSecond: 50 });

      expect(await screen.findByText("50")).toBeVisible();
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
      expect(screen.getByText(label)).toBeVisible();
    });

    it("shows Default for a provisioned service with no limit", async () => {
      renderDetail({ ...service, provisioned: true });

      expect(await screen.findByText("Default")).toBeVisible();
    });
  });
});
