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
  authMock.permissions = [];
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
});
