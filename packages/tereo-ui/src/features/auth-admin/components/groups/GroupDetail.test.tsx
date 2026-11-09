import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Group } from "../../api/groups/types";
import { GroupDetail } from "./GroupDetail";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const group: Group = {
  id: "g1",
  organizationId: null,
  slug: "support",
  name: "Support",
  description: null,
  definitionSource: "local",
  membershipSource: "local",
  unprovisionedAt: null,
  archivedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  memberCount: 1,
};

const members = [
  {
    userId: "u1",
    email: "ada@example.com",
    name: "Ada",
    isActive: true,
    addedAt: "2026-10-02T00:00:00Z",
  },
];

const roles = [
  { id: "r1", name: "agent", displayName: "Agent", serviceId: null },
];

type Read = "group" | "members" | "roles" | "allRoles";

const refusal = (status: number, error_description: string) =>
  Object.assign(new Error(error_description), {
    response: { status, data: { error: "x", error_description } },
  });

const renderDetail = (
  data: Group,
  held: object[] = roles,
  allRoles: object[] = [],
  pendingRoles = false,
  failures: Partial<Record<Read, Error>> = {}
) => {
  authMock.axios.get.mockImplementation(async (url: string) => {
    const path = String(url);
    const read: Read = path.endsWith("/members")
      ? "members"
      : path === "/v1/admin/roles"
        ? "allRoles"
        : path.endsWith("/roles")
          ? "roles"
          : "group";
    if (failures[read]) throw failures[read];
    if (path.endsWith("/members")) {
      return {
        data: { data: members, hasMore: false, limit: 50, nextCursor: null },
      };
    }
    if (path === "/v1/admin/roles") {
      return { data: { data: allRoles, hasMore: false, nextCursor: null } };
    }
    if (path.endsWith("/roles")) {
      if (pendingRoles) return new Promise(() => undefined);
      return { data: { data: held, nextCursor: null } };
    }
    return { data };
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/groups/g1"]}>
        <Routes>
          <Route path="/groups/:groupId" element={<GroupDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  authMock.axios.get.mockReset();
  authMock.permissions = ["groups.read", "groups.write", "groups.archive"];
  authMock.organizations = [];
});

describe("GroupDetail", () => {
  it("lists the members, then the roles on the Roles tab", async () => {
    renderDetail(group);

    expect(await screen.findByText("ada@example.com")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /^Roles/ }));
    expect(await screen.findByText("Agent")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit roles" })).toBeEnabled();
  });

  it("locks a provisioned group's fields, roles and archive but not its members", async () => {
    renderDetail({ ...group, definitionSource: "provisioned" });

    expect(await screen.findByText("Managed by provisioning")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Archive" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add members" })).toBeEnabled();
    expect(await screen.findByTitle("Remove")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: /^Roles/ }));
    expect(
      await screen.findByRole("button", { name: "Edit roles" })
    ).toBeDisabled();
  });

  it("offers no write controls without groups.write", async () => {
    authMock.permissions = ["groups.read"];
    renderDetail(group);

    await screen.findByText("ada@example.com");
    expect(screen.queryByRole("button", { name: "Add members" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByTitle("Remove")).toBeNull();
  });

  it("lets an organization admin manage its group without groups.*", async () => {
    authMock.permissions = [];
    authMock.organizations = [
      { id: "o1", name: "Acme", slug: "acme", memberRole: "admin" },
    ];
    renderDetail({ ...group, organizationId: "o1" });

    expect(
      await screen.findByRole("button", { name: "Add members" })
    ).toBeEnabled();
  });

  it("freezes an archived group", async () => {
    renderDetail({ ...group, archivedAt: "2026-10-05T00:00:00Z" });

    expect(await screen.findByTitle("Restore")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add members" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  });

  it("keeps a held archived role in the PUT when another role is ticked", async () => {
    authMock.axios.put.mockResolvedValue({ data: {} });
    renderDetail(
      group,
      [{ id: "r-old", name: "old", displayName: "Old", serviceId: null }],
      [{ id: "r-new", name: "new", displayName: "New", isActive: true }]
    );

    fireEvent.click(await screen.findByRole("tab", { name: /^Roles/ }));
    const edit = await screen.findByRole("button", { name: "Edit roles" });
    await waitFor(() => expect(edit).toBeEnabled());
    fireEvent.click(edit);
    fireEvent.click(await screen.findByLabelText("New"));
    expect(screen.getByLabelText(/Old \(archived/)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save Roles" }));

    await waitFor(() =>
      expect(authMock.axios.put).toHaveBeenCalledWith(
        "/v1/admin/groups/g1/roles",
        { roleIds: ["r-new", "r-old"] }
      )
    );
  });

  it("disables Edit roles until the roles have loaded", async () => {
    renderDetail(group, roles, [], true);

    fireEvent.click(await screen.findByRole("tab", { name: /^Roles/ }));
    expect(
      await screen.findByRole("button", { name: "Edit roles" })
    ).toBeDisabled();
  });

  it("says not found only for a 404", async () => {
    renderDetail(group, roles, [], false, {
      group: refusal(404, "Group not found"),
    });
    expect(await screen.findByText("Group not found")).toBeVisible();
  });

  it("shows the error of a failed group load", async () => {
    renderDetail(group, roles, [], false, {
      group: refusal(403, "The following permission is required: groups.read"),
    });
    expect(
      await screen.findByText(
        "The following permission is required: groups.read"
      )
    ).toBeVisible();
    expect(screen.queryByText("Group not found")).toBeNull();
  });

  it("shows failed member and role loads as errors, not empty tables", async () => {
    renderDetail(group, roles, [], false, {
      members: refusal(500, "Members exploded"),
      roles: refusal(500, "Roles exploded"),
    });
    expect(await screen.findByText("Members exploded")).toBeVisible();
    expect(screen.queryByText("No members in this group")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /^Roles/ }));
    expect(await screen.findByText("Roles exploded")).toBeVisible();
    expect(screen.queryByText("This group holds no roles")).toBeNull();
  });

  describe("an organization group's roles", () => {
    const orgGroup = { ...group, organizationId: "o1" };
    const custom = (id: string, orgAssignable: boolean) => ({
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
          orgAssignable,
        },
      ],
    });

    const openRoles = async () => {
      fireEvent.click(await screen.findByRole("tab", { name: /^Roles/ }));
      const edit = await screen.findByRole("button", { name: "Edit roles" });
      await waitFor(() => expect(edit).toBeEnabled());
      fireEvent.click(edit);
    };

    it("offers only custom, org-assignable roles, keeping held ones", async () => {
      renderDetail(
        orgGroup,
        [{ id: "held", name: "held", displayName: "held", serviceId: null }],
        [
          custom("scoped", true),
          custom("platform", false),
          custom("held", false),
          { ...custom("system", true), isSystem: true },
        ]
      );
      await openRoles();

      expect(await screen.findByLabelText("scoped")).toBeEnabled();
      expect(screen.getByLabelText("held")).toBeChecked();
      expect(screen.queryByLabelText("platform")).toBeNull();
      expect(screen.queryByLabelText(/system/)).toBeNull();
    });

    it("shows a failed role load and refuses to save", async () => {
      renderDetail(orgGroup, roles, [], false, {
        allRoles: refusal(
          403,
          "The following permission is required: roles.read"
        ),
      });
      await openRoles();

      expect(
        await screen.findByText(
          "The following permission is required: roles.read"
        )
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Save Roles" })).toBeDisabled();
      expect(screen.queryByLabelText(/archived or inactive/)).toBeNull();
    });
  });
});
