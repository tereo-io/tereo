import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import InviteGuestModal from "./InviteGuestModal";
import { MemoryRouter } from "react-router-dom";
import { authMock } from "@/test/authMock";
import { AxiosError } from "axios";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const roles = [
  {
    id: "r1",
    name: "demos.viewer",
    displayName: "Demo viewer",
    isActive: true,
    guestAssignable: true,
  },
  {
    id: "r2",
    name: "admin",
    displayName: "Admin",
    isActive: true,
    guestAssignable: false,
  },
];

const coreError = (status: number, data: object) =>
  new AxiosError("Request failed", undefined, undefined, undefined, {
    status,
    data,
  } as never);

const renderModal = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <InviteGuestModal orgId="o1" show onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  authMock.axios.get.mockReset();
  authMock.axios.post.mockReset();
  authMock.axios.get.mockResolvedValue({
    data: { data: roles, hasMore: false },
  });
});

describe("InviteGuestModal", () => {
  it("posts the spec body for a password setup link", async () => {
    const user = userEvent.setup();
    authMock.axios.post.mockResolvedValue({
      data: {
        user: { email: "jane@customer.com", expiresAt: null },
        created: true,
        passwordSetupUrl: "https://core.test/set-password#token=abc",
      },
    });
    renderModal();

    await user.type(
      screen.getByLabelText(/^Email(?! the)/),
      "jane@customer.com"
    );
    await user.type(screen.getByLabelText(/^Name/), "Jane Doe");
    await user.click(await screen.findByLabelText("Demo viewer"));
    expect(screen.queryByLabelText("Admin")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Invite Guest" }));

    await waitFor(() =>
      expect(authMock.axios.post).toHaveBeenCalledWith("/v1/admin/guests", {
        email: "jane@customer.com",
        name: "Jane Doe",
        organizationId: "o1",
        roles: ["demos.viewer"],
        expiresIn: 30 * 86400,
        initialAccess: { type: "password_setup_link", notify: false },
      })
    );
    expect(await screen.findByText(/token=abc/)).toBeVisible();
  });

  it("defaults 'must change' to checked for a password", async () => {
    const user = userEvent.setup();
    authMock.axios.post.mockResolvedValue({
      data: { user: { email: "jane@customer.com" }, created: true },
    });
    renderModal();

    await user.type(
      screen.getByLabelText(/^Email(?! the)/),
      "jane@customer.com"
    );
    await user.click(screen.getByLabelText("Set a password"));
    expect(screen.getByLabelText("Must change at first sign-in")).toBeChecked();
    await user.type(
      screen.getByLabelText(/^Password(?! setup)/),
      "Str0ng-pass-phrase"
    );
    await user.click(screen.getByRole("button", { name: "Invite Guest" }));

    await waitFor(() =>
      expect(authMock.axios.post).toHaveBeenCalledWith(
        "/v1/admin/guests",
        expect.objectContaining({
          initialAccess: {
            type: "password",
            password: "Str0ng-pass-phrase",
            mustChange: true,
          },
        })
      )
    );
  });

  it("says when the person already has an account", async () => {
    const user = userEvent.setup();
    authMock.axios.post.mockRejectedValue(
      coreError(409, { error: "user_exists", userId: "u9" })
    );
    renderModal();

    await user.type(screen.getByLabelText(/^Email(?! the)/), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Invite Guest" }));

    expect(
      await screen.findByText(/This person already has an account/)
    ).toBeVisible();
  });
});
