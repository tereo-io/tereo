import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EffectiveBranding } from "@/features/auth/branding";
import { makeBranding } from "@/features/auth/branding/fixtures";
import { render, screen, waitFor } from "@testing-library/react";
import { BrandingProvider } from "@/features/auth/branding";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { authMock } from "@/test/authMock";
import { LoginPage } from "./LoginPage";

vi.mock("@/lib/auth", () => ({ usePublicAxios: () => authMock.axios }));

const renderPage = (
  branding: EffectiveBranding | null,
  resetEnabled = false
) => {
  authMock.axios.get.mockImplementation(async (path: string) =>
    path === "/v1/password-reset/status"
      ? { data: { enabled: resetEnabled } }
      : { data: [] }
  );
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/login?client_id=acme"]}>
        <BrandingProvider override={branding}>
          <LoginPage />
        </BrandingProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

describe("LoginPage branding", () => {
  it("renders the branded copy", () => {
    renderPage(
      makeBranding({
        headline: "Welcome back",
        subtitle: "Use your Acme login",
        notice: "Maintenance tonight",
        signInLabel: "Enter",
      })
    );
    expect(screen.getByText("Welcome back")).toBeInTheDocument();
    expect(screen.getByText("Use your Acme login")).toBeInTheDocument();
    expect(screen.getByText("Maintenance tonight")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enter" })).toBeInTheDocument();
  });

  it("falls back to the stock copy", () => {
    renderPage(null);
    expect(screen.getByText("Sign in to continue")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign In" })).toBeInTheDocument();
  });
});

describe("LoginPage forgot password", () => {
  it("shows Forgot password? only when reset is enabled", async () => {
    const { unmount } = renderPage(null, true);
    expect(
      await screen.findByRole("link", { name: "Forgot password?" })
    ).toBeVisible();
    unmount();

    renderPage(null, false);
    await screen.findByText("Sign in to continue");
    await waitFor(() =>
      expect(authMock.axios.get).toHaveBeenCalledWith(
        "/v1/password-reset/status"
      )
    );
    expect(screen.queryByRole("link", { name: "Forgot password?" })).toBeNull();
  });
});
