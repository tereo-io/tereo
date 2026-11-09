import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OrganizationMember } from "../../../api/organizations/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ManageMemberOrgRolesButton from "./ManageMemberOrgRolesButton";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const member: OrganizationMember = {
  id: "m1",
  memberRole: "member",
  createdAt: "2026-10-01T00:00:00Z",
  user: { id: "u1", email: "ada@example.com", name: "Ada", isActive: true },
};

const role = (id: string) => ({
  id,
  name: id,
  displayName: id,
  isActive: true,
  isSystem: false,
  permissions: [
    {
      id: `p-${id}`,
      name: `p.${id}`,
      displayName: `p.${id}`,
      retired: false,
      orgAssignable: true,
    },
  ],
});

const memberRoles = {
  organizationId: "o1",
  userId: "u1",
  roles: [
    {
      id: "direct",
      name: "direct",
      displayName: "direct",
      expiresAt: null,
      via: { kind: "direct" },
    },
  ],
  groupRoles: [
    {
      id: "agent",
      name: "agent",
      displayName: "agent",
      organizationId: "o1",
      via: { kind: "group", groupId: "g1" },
      group: { id: "g1", slug: "support", name: "Support" },
    },
  ],
};

const renderButton = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <ManageMemberOrgRolesButton orgId="o1" member={member} />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  authMock.permissions = ["roles.read"];
  authMock.organizations = [
    { id: "o1", name: "Acme", slug: "acme", memberRole: "admin" },
  ];
  authMock.axios.get.mockReset();
  authMock.axios.put.mockReset();
  authMock.axios.get.mockImplementation(async (url: string) => {
    if (url === "/v1/admin/roles") {
      return {
        data: {
          data: [role("direct"), role("agent")],
          hasMore: false,
          nextCursor: null,
        },
      };
    }
    return { data: memberRoles };
  });
});

describe("ManageMemberOrgRolesButton", () => {
  it("lists group-held roles apart, read-only, via a link to the group", async () => {
    renderButton();
    fireEvent.click(screen.getByTitle("Organization roles"));

    expect(await screen.findByText("Support")).toHaveAttribute(
      "href",
      "/auth-admin/groups/g1"
    );
    expect(screen.getByLabelText("direct")).toBeChecked();
    expect(screen.getByLabelText("agent")).not.toBeChecked();
  });

  it("never turns a group-held role into a direct one on save", async () => {
    authMock.axios.put.mockResolvedValue({ data: memberRoles });
    renderButton();
    fireEvent.click(screen.getByTitle("Organization roles"));
    await screen.findByText("Support");

    fireEvent.click(screen.getByRole("button", { name: "Save Roles" }));

    await waitFor(() =>
      expect(authMock.axios.put).toHaveBeenCalledWith(
        "/v1/admin/organizations/o1/members/u1/roles",
        { roleIds: ["direct"] }
      )
    );
  });

  it("keeps held archived and inactive roles, locked, in the PUT", async () => {
    authMock.axios.put.mockResolvedValue({ data: memberRoles });
    const held = (id: string) => ({
      id,
      name: id,
      displayName: id,
      expiresAt: null,
      via: { kind: "direct" },
    });
    authMock.axios.get.mockImplementation(async (url: string) =>
      url === "/v1/admin/roles"
        ? {
            data: {
              data: [
                role("direct"),
                role("agent"),
                { ...role("dormant"), isActive: false },
              ],
              hasMore: false,
              nextCursor: null,
            },
          }
        : {
            data: {
              ...memberRoles,
              roles: [held("direct"), held("gone"), held("dormant")],
            },
          }
    );
    renderButton();
    fireEvent.click(screen.getByTitle("Organization roles"));

    fireEvent.click(await screen.findByLabelText("agent"));
    expect(screen.getByLabelText(/gone \(archived/)).toBeDisabled();
    expect(screen.getByLabelText(/gone \(archived/)).toBeChecked();
    expect(screen.getByLabelText(/dormant \(archived/)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save Roles" }));

    await waitFor(() =>
      expect(authMock.axios.put).toHaveBeenCalledWith(
        "/v1/admin/organizations/o1/members/u1/roles",
        { roleIds: ["direct", "agent", "gone", "dormant"] }
      )
    );
  });

  it("says roles.read is needed instead of offering an empty picker", async () => {
    authMock.permissions = [];
    renderButton();
    fireEvent.click(screen.getByTitle("Organization roles"));

    expect(await screen.findByText(/roles\.read/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Roles" })).toBeDisabled();
    expect(authMock.axios.get).not.toHaveBeenCalledWith(
      "/v1/admin/roles",
      expect.anything()
    );
  });

  it("shows a failed role load and refuses to save", async () => {
    authMock.axios.get.mockImplementation(async (url: string) => {
      if (url === "/v1/admin/roles") throw new Error("Roles exploded");
      return { data: memberRoles };
    });
    renderButton();
    fireEvent.click(screen.getByTitle("Organization roles"));

    expect(await screen.findByText(/Could not load the roles/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Roles" })).toBeDisabled();
  });

  it("shows no group section when core withholds groupRoles", async () => {
    authMock.axios.put.mockResolvedValue({ data: memberRoles });
    authMock.axios.get.mockImplementation(async (url: string) =>
      url === "/v1/admin/roles"
        ? {
            data: {
              data: [role("direct"), role("agent")],
              hasMore: false,
              nextCursor: null,
            },
          }
        : { data: { ...memberRoles, groupRoles: [] } }
    );
    renderButton();
    fireEvent.click(screen.getByTitle("Organization roles"));

    expect(await screen.findByLabelText("direct")).toBeChecked();
    expect(screen.queryByText(/Through this organization/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save Roles" }));
    await waitFor(() =>
      expect(authMock.axios.put).toHaveBeenCalledWith(
        "/v1/admin/organizations/o1/members/u1/roles",
        { roleIds: ["direct"] }
      )
    );
  });
});
