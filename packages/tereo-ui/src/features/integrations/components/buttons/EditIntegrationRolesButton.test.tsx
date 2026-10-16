import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import EditIntegrationRolesButton from "./EditIntegrationRolesButton";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Integration } from "../../api/types";
import { authMock } from "@/test/authMock";
import type {
  Role,
  RolePermission,
} from "@/features/auth-admin/api/roles/types";

vi.mock("@/lib/auth", async () => ({
  ...(await import("@/test/authMock")).mockAuthModule(),
  useAuth: () => ({ hasPermission: () => true }),
}));

const permission = (name: string): RolePermission => ({
  id: name,
  name,
  displayName: name,
  retired: false,
  orgAssignable: false,
});

const role = (id: string, displayName: string, permissions: string[]) =>
  ({
    id,
    name: id,
    displayName,
    isSystem: id === "core-admin",
    isActive: true,
    retiredAt: null,
    permissions: permissions.map(permission),
  }) as Role;

const platform = {
  id: "i1",
  name: "Acme",
  organizationId: null,
  organization: null,
  roles: [],
} as unknown as Integration;

beforeEach(() => authMock.axios.get.mockReset());

describe("EditIntegrationRolesButton", () => {
  it("never offers a platform integration a role carrying admin", async () => {
    authMock.axios.get.mockResolvedValue({
      data: {
        data: [
          role("core-admin", "Administrator", ["admin"]),
          role("custom-admin", "Everything", ["users.read", "admin"]),
          role("reader", "User reader", ["users.read"]),
        ],
        hasMore: false,
        nextCursor: null,
      },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EditIntegrationRolesButton integration={platform} />
      </QueryClientProvider>
    );

    await userEvent.click(screen.getByRole("button", { name: "Edit Roles" }));
    expect(await screen.findByLabelText("User reader")).toBeInTheDocument();
    expect(screen.queryByLabelText("Administrator")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Everything")).not.toBeInTheDocument();
  });
});
