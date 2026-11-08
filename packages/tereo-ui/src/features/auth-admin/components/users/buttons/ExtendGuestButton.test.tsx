import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP_MARGIN_SECONDS } from "../../../api/guests/guestDurations";
import type { User } from "@/features/auth-admin/api/users/types";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ExtendGuestButton from "./ExtendGuestButton";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const DAY = 86_400;
const NOW = new Date("2026-11-06T12:00:00Z").getTime();

const guest: User = {
  id: "g1",
  email: "guest@example.com",
  name: null,
  isActive: true,
  userType: "guest",
  expiresAt: "2026-11-10T00:00:00Z",
  status: "active",
  passwordChangeRequired: false,
  hasPassword: false,
  emailVerified: false,
  emailVerifiedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

let maxTtlSeconds = 90 * DAY;

const renderButton = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ExtendGuestButton user={guest} />
    </QueryClientProvider>
  );

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  maxTtlSeconds = 90 * DAY;
  authMock.axios.get.mockReset();
  authMock.axios.patch.mockReset();
  authMock.axios.get.mockImplementation(async (url: string) => {
    if (url === "/v1/admin/guests/options") {
      return { data: { roles: [], defaultRoleIds: [], maxTtlSeconds } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  authMock.axios.patch.mockResolvedValue({ data: guest });
});

afterEach(() => vi.restoreAllMocks());

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Extend" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Set expiry" })).toBeEnabled()
  );
  return screen.getByLabelText(/^New expiry/) as HTMLSelectElement;
};

describe("ExtendGuestButton", () => {
  it("offers only extensions within core's cap", async () => {
    const user = userEvent.setup();
    maxTtlSeconds = 30 * DAY;
    renderButton();

    const select = await open(user);
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "7 days from now",
      "30 days from now",
    ]);
  });

  it("sends a shorter extension as is", async () => {
    const user = userEvent.setup();
    renderButton();

    const select = await open(user);
    await user.selectOptions(select, String(7 * DAY));
    await user.click(screen.getByRole("button", { name: "Set expiry" }));

    await waitFor(() =>
      expect(authMock.axios.patch).toHaveBeenCalledWith("/v1/admin/guests/g1", {
        expiresAt: new Date(NOW + 7 * DAY * 1000).toISOString(),
      })
    );
  });

  it("holds an extension at the cap back by a margin", async () => {
    const user = userEvent.setup();
    maxTtlSeconds = 30 * DAY;
    renderButton();

    await open(user);
    await user.click(screen.getByRole("button", { name: "Set expiry" }));

    await waitFor(() =>
      expect(authMock.axios.patch).toHaveBeenCalledWith("/v1/admin/guests/g1", {
        expiresAt: new Date(
          NOW + (30 * DAY - CAP_MARGIN_SECONDS) * 1000
        ).toISOString(),
      })
    );
  });
});
