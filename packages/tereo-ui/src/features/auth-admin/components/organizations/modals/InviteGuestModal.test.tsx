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

const DAY = 86_400;

let options = {
  roles: [
    {
      id: "r1",
      name: "demos.viewer",
      displayName: "Demo viewer",
      description: null,
    },
    {
      id: "r3",
      name: "demos.commenter",
      displayName: "Demo commenter",
      description: null,
    },
  ],
  defaultRoleIds: [] as string[],
  maxTtlSeconds: 90 * DAY,
};

const coreError = (status: number, data: object) =>
  new AxiosError("Request failed", undefined, undefined, undefined, {
    status,
    data,
  } as never);

const renderModal = (
  props: Partial<React.ComponentProps<typeof InviteGuestModal>> = {
    orgId: "o1",
  }
) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <InviteGuestModal show onClose={vi.fn()} {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  authMock.axios.get.mockReset();
  authMock.axios.post.mockReset();
  options = { ...options, defaultRoleIds: [], maxTtlSeconds: 90 * DAY };
  authMock.axios.get.mockImplementation(async (url: string) => {
    if (url === "/v1/admin/guests/options") return { data: options };
    throw new Error(`unexpected GET ${url}`);
  });
});

const fillEmail = async (user: ReturnType<typeof userEvent.setup>) =>
  user.type(screen.getByLabelText(/^Email(?! the)/), "jane@customer.com");

const accessLasts = () =>
  screen.getByLabelText(/^Access lasts/) as HTMLSelectElement;

const optionLabels = (select: HTMLSelectElement) =>
  [...select.options].map((o) => o.textContent);

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
    await user.click(screen.getByRole("button", { name: "Invite Guest" }));

    await waitFor(() =>
      expect(authMock.axios.post).toHaveBeenCalledWith("/v1/admin/guests", {
        email: "jane@customer.com",
        name: "Jane Doe",
        organizationId: "o1",
        roles: ["r1"],
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

    await fillEmail(user);
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

  it("reads its roles from the guest options, not the roles list", async () => {
    renderModal();
    expect(await screen.findByLabelText("Demo commenter")).toBeVisible();
    expect(authMock.axios.get).toHaveBeenCalledWith("/v1/admin/guests/options");
    expect(authMock.axios.get).not.toHaveBeenCalledWith(
      expect.stringContaining("/v1/admin/roles")
    );
  });

  it("shows the defaults checked and leaves roles out while untouched", async () => {
    const user = userEvent.setup();
    options.defaultRoleIds = ["r3"];
    authMock.axios.post.mockResolvedValue({
      data: { user: { email: "jane@customer.com" }, created: true },
    });
    renderModal();

    expect(await screen.findByLabelText("Demo commenter")).toBeChecked();
    expect(screen.getByLabelText("Demo viewer")).not.toBeChecked();
    await fillEmail(user);
    await user.click(screen.getByRole("button", { name: "Invite Guest" }));

    await waitFor(() => expect(authMock.axios.post).toHaveBeenCalled());
    expect(authMock.axios.post.mock.calls[0][1]).not.toHaveProperty("roles");
  });

  it("sends an empty role list when the defaults are unchecked", async () => {
    const user = userEvent.setup();
    options.defaultRoleIds = ["r3"];
    authMock.axios.post.mockResolvedValue({
      data: { user: { email: "jane@customer.com" }, created: true },
    });
    renderModal();

    await user.click(await screen.findByLabelText("Demo commenter"));
    await fillEmail(user);
    await user.click(screen.getByRole("button", { name: "Invite Guest" }));

    await waitFor(() =>
      expect(authMock.axios.post).toHaveBeenCalledWith(
        "/v1/admin/guests",
        expect.objectContaining({ roles: [] })
      )
    );
  });

  it("offers only expiries within core's cap", async () => {
    const user = userEvent.setup();
    options.maxTtlSeconds = 30 * DAY;
    authMock.axios.post.mockResolvedValue({
      data: { user: { email: "jane@customer.com" }, created: true },
    });
    renderModal();

    await screen.findByLabelText("Demo viewer");
    expect(optionLabels(accessLasts())).toEqual(["7 days", "30 days"]);
    await fillEmail(user);
    await user.click(screen.getByRole("button", { name: "Invite Guest" }));

    await waitFor(() =>
      expect(authMock.axios.post).toHaveBeenCalledWith(
        "/v1/admin/guests",
        expect.objectContaining({ expiresIn: 30 * DAY })
      )
    );
  });

  it("offers the cap alone when it is under a week", async () => {
    const user = userEvent.setup();
    options.maxTtlSeconds = 2 * DAY;
    authMock.axios.post.mockResolvedValue({
      data: { user: { email: "jane@customer.com" }, created: true },
    });
    renderModal();

    await screen.findByLabelText("Demo viewer");
    expect(optionLabels(accessLasts())).toEqual(["2 days"]);
    await fillEmail(user);
    await user.click(screen.getByRole("button", { name: "Invite Guest" }));

    await waitFor(() =>
      expect(authMock.axios.post).toHaveBeenCalledWith(
        "/v1/admin/guests",
        expect.objectContaining({ expiresIn: 2 * DAY })
      )
    );
  });

  it("asks for an organization when given none", async () => {
    const user = userEvent.setup();
    authMock.axios.post.mockResolvedValue({
      data: { user: { email: "jane@customer.com" }, created: true },
    });
    renderModal({
      organizations: [
        { id: "o1", name: "Acme" },
        { id: "o2", name: "Globex" },
      ],
    });

    await screen.findByLabelText("Demo viewer");
    await user.selectOptions(screen.getByLabelText(/^Organization/), "o2");
    await fillEmail(user);
    await user.click(screen.getByRole("button", { name: "Invite Guest" }));

    await waitFor(() =>
      expect(authMock.axios.post).toHaveBeenCalledWith(
        "/v1/admin/guests",
        expect.objectContaining({ organizationId: "o2" })
      )
    );
  });

  it("words email_unavailable without naming the account", async () => {
    const user = userEvent.setup();
    authMock.axios.post.mockRejectedValue(
      coreError(409, { error: "email_unavailable" })
    );
    renderModal();

    await fillEmail(user);
    await user.click(screen.getByRole("button", { name: "Invite Guest" }));

    expect(
      await screen.findByText(
        "This email can't be invited. Ask an administrator."
      )
    ).toBeVisible();
  });
});
