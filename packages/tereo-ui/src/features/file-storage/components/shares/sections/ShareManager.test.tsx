import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { screen } from "@testing-library/react";
import { authMock } from "@/test/authMock";
import ShareManager from "./ShareManager";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const share = {
  id: "s1",
  token: "t",
  bucketId: 1,
  kind: "OBJECT",
  url: "https://core.example/s/t",
  urlFilename: null,
  objectId: "o1",
  versionId: null,
  archiveRequestId: null,
  hasPassword: false,
  expiresAt: null,
  maxDownloads: null,
  downloadCount: 0,
  revokedAt: null,
  revokedByUserId: null,
  revokedByUser: null,
  note: null,
  createdByUserId: "someone-else",
  creator: null,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  status: "active",
  object: { id: "o1", objectKey: "a.png" },
  archiveRequest: null,
};

const serve = (grant: Record<string, boolean>) =>
  authMock.axios.get.mockImplementation(async (url: string) =>
    url.includes("/my-permissions")
      ? { data: grant }
      : { data: { data: [share], hasMore: false, nextCursor: null } }
  );

beforeEach(() => {
  authMock.permissions = [
    "file-service.shares.read",
    "file-service.shares.write",
    "file-service.shares.delete",
    "file-service.objects.write",
    "file-service.objects.delete",
  ];
  authMock.axios.get.mockReset();
});

describe("ShareManager", () => {
  it("offers edit and revoke on another's share with write and delete access", async () => {
    serve({
      canRead: true,
      canWrite: true,
      canDelete: true,
      canRevokeShares: true,
      coreManaged: false,
    });
    renderWithProviders(<ShareManager bucketName="b" />);
    expect(
      await screen.findByRole("button", { name: "Revoke share" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit share" })
    ).toBeInTheDocument();
  });

  it("on a core bucket, offers revoke but not edit", async () => {
    serve({
      canRead: true,
      canWrite: false,
      canDelete: false,
      canRevokeShares: true,
      coreManaged: true,
    });
    renderWithProviders(<ShareManager bucketName="auth-service-branding" />);
    expect(
      await screen.findByRole("button", { name: "Revoke share" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit share" })).toBeNull();
  });
});
