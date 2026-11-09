import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationDetail } from "./OrganizationDetail";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const organization = {
  id: "o1",
  name: "Acme",
  slug: "acme",
  code: "ACME",
  isDefault: false,
  isActive: true,
  archivedAt: null,
  memberCount: 0,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

const renderDetail = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/auth-admin/organizations/o1"]}>
        <Routes>
          <Route
            path="/auth-admin/organizations/:organizationId"
            element={<OrganizationDetail />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  authMock.organizations = [];
  authMock.axios.get.mockReset();
  authMock.axios.get.mockImplementation(async (url: string) => {
    if (url === "/v1/admin/organizations/o1") return { data: organization };
    if (url === "/v1/admin/organizations/o1/members") {
      return { data: { members: [] } };
    }
    if (url.startsWith("/v1/admin/groups?")) {
      return {
        data: {
          data: [
            {
              id: "g1",
              organizationId: "o1",
              slug: "support",
              name: "Support",
              description: null,
              definitionSource: "local",
              membershipSource: "local",
              unprovisionedAt: null,
              archivedAt: null,
              createdAt: "2026-10-01T00:00:00Z",
              updatedAt: "2026-10-01T00:00:00Z",
              memberCount: 3,
            },
          ],
          hasMore: false,
          limit: 25,
          nextCursor: null,
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  });
});

const membership = (id: string) => ({
  id,
  name: id,
  slug: id,
  memberRole: "member",
});

describe("OrganizationDetail guest invites", () => {
  it("hides Invite Guest from a guest inviter outside the organization", async () => {
    authMock.permissions = ["organizations.read", "users.guests.write"];
    authMock.organizations = [membership("o2")];
    renderDetail();

    expect(await screen.findByText("Organization Details")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Invite Guest" })).toBeNull();
  });

  it("shows it to a guest inviter who belongs to the organization", async () => {
    authMock.permissions = ["organizations.read", "users.guests.write"];
    authMock.organizations = [membership("o1")];
    renderDetail();

    expect(
      await screen.findByRole("button", { name: "Invite Guest" })
    ).toBeVisible();
  });

  it("shows it to a guest inviter holding organizations.write", async () => {
    authMock.permissions = [
      "organizations.read",
      "organizations.write",
      "users.guests.write",
    ];
    renderDetail();

    expect(
      await screen.findByRole("button", { name: "Invite Guest" })
    ).toBeVisible();
  });
});

describe("OrganizationDetail groups", () => {
  it("lists the organization's groups on the Groups tab", async () => {
    authMock.permissions = ["organizations.read", "groups.read"];
    renderDetail();

    fireEvent.click(await screen.findByRole("tab", { name: "Groups" }));

    expect(await screen.findByText("Support")).toBeVisible();
    expect(
      authMock.axios.get.mock.calls.some(([url]) =>
        String(url).includes("organizationId=o1")
      )
    ).toBe(true);
    // Core hides archived groups unless includeArchived is set.
    expect(
      authMock.axios.get.mock.calls.some(([url]) =>
        /[?&](includeArchived|archived)=/.test(String(url))
      )
    ).toBe(false);
  });

  it("hides the tab from someone who cannot read the groups", async () => {
    authMock.permissions = ["organizations.read"];
    renderDetail();

    await screen.findByText("Organization Details");
    expect(screen.queryByRole("tab", { name: "Groups" })).toBeNull();
  });
});
