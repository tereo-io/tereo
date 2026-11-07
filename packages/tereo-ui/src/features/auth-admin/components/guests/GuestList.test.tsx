import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../../api/users/types";
import { MemoryRouter } from "react-router-dom";
import { authMock } from "@/test/authMock";
import { GuestList } from "./GuestList";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const guest = (overrides: Partial<User>): User => ({
  id: "g1",
  email: "guest@example.com",
  name: "Guest",
  isActive: true,
  userType: "guest",
  expiresAt: "2026-12-01T00:00:00Z",
  status: "active",
  passwordChangeRequired: false,
  hasPassword: false,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  ...overrides,
});

const guests = [
  guest({}),
  guest({ id: "g2", email: "set@example.com", hasPassword: true }),
];

const renderList = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <GuestList />
      </MemoryRouter>
    </QueryClientProvider>
  );

const rowOf = async (email: string) =>
  (await screen.findByText(email)).closest("tr") as HTMLElement;

beforeEach(() => {
  authMock.permissions = [];
  authMock.organizations = [];
  authMock.axios.get.mockReset();
  authMock.axios.get.mockImplementation(async (url: string) => {
    if (url.startsWith("/v1/admin/guests?")) {
      return {
        data: { data: guests, hasMore: false, limit: 25, nextCursor: null },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  });
});

describe("GuestList", () => {
  it("lists guests through the guest endpoint for users.guests.read alone", async () => {
    authMock.permissions = ["users.guests.read"];
    renderList();

    const row = await rowOf("guest@example.com");
    expect(within(row).queryByRole("link")).toBeNull();
    expect(within(row).queryByRole("button", { name: "Extend" })).toBeNull();
    expect(authMock.axios.get).not.toHaveBeenCalledWith(
      expect.stringContaining("/v1/admin/users")
    );
  });

  it("offers extend and a password link to users.guests.write", async () => {
    authMock.permissions = ["users.guests.read", "users.guests.write"];
    renderList();

    const row = await rowOf("guest@example.com");
    expect(within(row).getByRole("button", { name: "Extend" })).toBeVisible();
    expect(
      within(row).getByRole("button", { name: "Send password link" })
    ).toBeVisible();
  });

  it("leaves out the link for a guest with a password without users.write", async () => {
    authMock.permissions = ["users.guests.read", "users.guests.write"];
    renderList();

    const row = await rowOf("set@example.com");
    expect(within(row).getByRole("button", { name: "Extend" })).toBeVisible();
    expect(
      within(row).queryByRole("button", { name: "Send password link" })
    ).toBeNull();
  });
});
