import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EffectiveBranding } from "@/features/auth/branding";
import { makeBranding } from "@/features/auth/branding/fixtures";
import { BrandingProvider } from "@/features/auth/branding";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { authMock } from "@/test/authMock";
import { LoginPage } from "./LoginPage";

vi.mock("@/lib/auth", () => ({ usePublicAxios: () => authMock.axios }));

const renderPage = (branding: EffectiveBranding | null) => {
  authMock.axios.get.mockResolvedValue({ data: [] });
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
