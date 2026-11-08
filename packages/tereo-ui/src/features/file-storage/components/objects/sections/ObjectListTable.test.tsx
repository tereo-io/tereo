import type { PrefixListEntry } from "@/features/file-storage/api/objects/useObjectPrefixes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { screen } from "@testing-library/react";
import ObjectListTable from "./ObjectListTable";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const entries: PrefixListEntry[] = [
  { type: "prefix", prefix: "logos/", objectCount: 1, totalSizeBytes: "1" },
  {
    type: "object",
    id: "o1",
    key: "a.txt",
    contentType: "text/plain",
    sizeBytes: "1",
    etag: "e",
    tags: [],
    updatedAt: "2026-11-01T00:00:00Z",
  },
];

const serve = (coreManaged: boolean) =>
  authMock.axios.get.mockImplementation(async (url: string) => ({
    data: url.includes("/my-permissions")
      ? {
          canRead: true,
          canWrite: !coreManaged,
          canDelete: !coreManaged,
          canRevokeShares: true,
          coreManaged,
        }
      : { name: "b", versioningEnabled: false, retiredAt: null, coreManaged },
  }));

const renderTable = () =>
  renderWithProviders(
    <ObjectListTable
      bucketName="b"
      data={entries}
      isLoading={false}
      hasMore={false}
      onQueryChange={() => {}}
      onReload={() => {}}
    />
  );

beforeEach(() => {
  authMock.permissions = [
    "file-service.objects.read",
    "file-service.shares.write",
  ];
  authMock.axios.get.mockReset();
});

describe("ObjectListTable", () => {
  it("offers sharing an object and a folder", async () => {
    serve(false);
    renderTable();
    expect(
      await screen.findByRole("button", { name: "Share a.txt" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Share folder logos" })
    ).toBeInTheDocument();
  });

  it("offers no sharing on a core bucket", async () => {
    serve(true);
    renderTable();
    await screen.findByText("a.txt");
    // Once my-permissions has answered.
    await vi.waitFor(() =>
      expect(authMock.axios.get).toHaveBeenCalledWith(
        "/buckets/b/my-permissions"
      )
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("button", { name: "Share a.txt" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Share folder logos" })
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Share Selected/ })).toBeNull();
  });
});
