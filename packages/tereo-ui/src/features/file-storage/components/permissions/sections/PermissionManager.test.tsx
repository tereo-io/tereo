import type { Bucket } from "@/features/file-storage/api/buckets/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionManager } from "./PermissionManager";
import { renderWithProviders } from "@/test/render";
import { screen } from "@testing-library/react";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const user = { id: "u0", email: "core@example.com", name: null };

const bucket = (coreManaged: boolean) =>
  ({
    id: 1,
    name: "b",
    description: null,
    policy: "private",
    currentUsageBytes: "0",
    versioningEnabled: false,
    autoThumbnails: false,
    corsConfig: null,
    rateLimitConfig: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    createdBy: "u0",
    creator: user,
    ownerId: "u0",
    owner: user,
    serviceId: coreManaged ? "core" : null,
    organizationId: null,
    organization: null,
    serviceName: null,
    service: null,
    missingSince: null,
    retiredAt: null,
    coreManaged,
  }) as Bucket;

const grant = {
  id: 1,
  userId: "u1",
  userEmail: "pat@example.com",
  userName: null,
  user: null,
  canRead: true,
  canWrite: false,
  canDelete: false,
  grantedAt: "2026-11-01T00:00:00Z",
  grantedBy: "u0",
  grantedByEmail: null,
  grantedByName: null,
  granter: null,
};

beforeEach(() => {
  authMock.permissions = [
    "file-service.permissions.read",
    "file-service.permissions.write",
    "file-service.permissions.delete",
  ];
  authMock.axios.get.mockReset();
  authMock.axios.get.mockResolvedValue({
    data: { data: [grant], hasMore: false, limit: 10, nextCursor: null },
  });
});

describe("PermissionManager", () => {
  it("lets a manager grant and revoke", async () => {
    renderWithProviders(<PermissionManager bucket={bucket(false)} canManage />);
    expect(await screen.findByTitle("Revoke")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add new" })).toBeInTheDocument();
  });

  it("on a core bucket, revokes but does not grant", async () => {
    renderWithProviders(<PermissionManager bucket={bucket(true)} canManage />);
    expect(await screen.findByTitle("Revoke")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add new" })).toBeNull();
  });
});
