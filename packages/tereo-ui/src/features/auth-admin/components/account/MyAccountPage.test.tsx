import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { AccountProfile } from "../../api/account/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { MyAccountPage } from "./MyAccountPage";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () => ({
  ...(await import("@/test/authMock")).mockAuthModule(),
  useLogout: () => vi.fn(),
}));

const profile: AccountProfile = {
  id: "u1",
  email: "ada@example.com",
  name: "Ada",
  isActive: true,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  photoUrl: null,
  hasPassword: true,
  emailVerified: false,
  emailVerifiedAt: null,
  roles: [],
  permissions: [],
  totp: {
    enabled: false,
    enabledAt: null,
    recoveryCodesRemaining: 0,
    required: false,
  },
};

const renderPage = (data: AccountProfile) => {
  authMock.axios.get.mockImplementation(async (path: string) => {
    if (String(path).endsWith("/sessions")) return { data: { sessions: [] } };
    if (String(path).endsWith("/me")) return { data };
    return { data: [] };
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <MyAccountPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  authMock.axios.get.mockReset();
  authMock.axios.post.mockReset();
  authMock.axios.post.mockResolvedValue({ data: undefined });
});

describe("MyAccountPage verification banner", () => {
  it("shows for an unverified user and resends", async () => {
    renderPage(profile);

    expect(
      await screen.findByText("Your email address isn't confirmed.")
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Resend" }));
    await waitFor(() =>
      expect(authMock.axios.post).toHaveBeenCalledWith(
        "/v1/account/email-verification"
      )
    );
  });

  it("is absent once verified", async () => {
    renderPage({
      ...profile,
      emailVerified: true,
      emailVerifiedAt: "2026-10-02T00:00:00Z",
    });

    await screen.findByText("Account Details");
    expect(
      screen.queryByText("Your email address isn't confirmed.")
    ).toBeNull();
  });
});
