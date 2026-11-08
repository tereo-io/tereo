import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BucketDetail } from "./BucketDetail";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const user = { id: "sys", email: "core@example.com", name: null };

const serve = (
  coreManaged: boolean,
  { versioningEnabled = false, canPurgeVersions = true } = {}
) =>
  authMock.axios.get.mockImplementation(async (url: string) => {
    if (url.endsWith("/my-permissions")) {
      return {
        data: {
          canRead: true,
          canWrite: !coreManaged,
          canDelete: !coreManaged,
          canRevokeShares: true,
          canPurgeVersions,
          coreManaged,
        },
      };
    }
    if (url === "/buckets/b") {
      return {
        data: {
          id: 1,
          name: "b",
          description: null,
          policy: "private",
          currentUsageBytes: "0",
          versioningEnabled,
          autoThumbnails: false,
          corsConfig: null,
          rateLimitConfig: null,
          createdAt: "2026-11-01T00:00:00Z",
          updatedAt: "2026-11-01T00:00:00Z",
          createdBy: "sys",
          creator: user,
          ownerId: "sys",
          owner: user,
          serviceId: coreManaged ? "core" : null,
          organizationId: null,
          organization: null,
          serviceName: null,
          service: null,
          missingSince: null,
          retiredAt: null,
          coreManaged,
        },
      };
    }
    return { data: { data: [], hasMore: false, nextCursor: null } };
  });

const renderDetail = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/buckets/b?tab=details"]}>
        <Routes>
          <Route path="/buckets/:bucketName" element={<BucketDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  authMock.permissions = [
    "file-service.admin",
    "file-service.buckets.read",
    "file-service.permissions.read",
  ];
  authMock.axios.get.mockReset();
});

describe("BucketDetail", () => {
  it("shows the Permissions tab to an admin of a core bucket", async () => {
    serve(true);
    renderDetail();
    expect(
      await screen.findByRole("button", { name: "Permissions" })
    ).toBeInTheDocument();
  });

  it("hides it on a core bucket from someone who doesn't manage it", async () => {
    authMock.permissions = [
      "file-service.buckets.read",
      "file-service.permissions.read",
    ];
    serve(true);
    renderDetail();
    expect(
      await screen.findByRole("button", { name: "Details" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Permissions" })).toBeNull();
  });

  it("offers an admin purging old versions of a versioned core bucket", async () => {
    serve(true, { versioningEnabled: true });
    renderDetail();
    expect(
      await screen.findByRole("button", { name: "Purge old versions" })
    ).toBeInTheDocument();
  });

  it("doesn't offer it when core says the caller may not purge", async () => {
    serve(true, { versioningEnabled: true, canPurgeVersions: false });
    renderDetail();
    expect(
      await screen.findByRole("button", { name: "Details" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Purge old versions" })
    ).toBeNull();
  });
});
