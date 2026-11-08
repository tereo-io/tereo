import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EffectiveBranding } from "@/features/auth/branding";
import { makeBranding } from "@/features/auth/branding/fixtures";
import { render, screen, waitFor } from "@testing-library/react";
import { BrandingProvider } from "@/features/auth/branding";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { authMock } from "@/test/authMock";
import { LoginPage } from "./LoginPage";

vi.mock("@/lib/auth", () => ({ usePublicAxios: () => authMock.axios }));

const Where = () => {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
};

const renderPage = (
  branding: EffectiveBranding | null,
  resetEnabled = false,
  url = "/login?client_id=acme"
) => {
  authMock.axios.get.mockImplementation(async (path: string) =>
    path === "/v1/password-reset/status"
      ? { data: { enabled: resetEnabled } }
      : { data: [] }
  );
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <BrandingProvider override={branding}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/forgot-password" element={<Where />} />
          </Routes>
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

  it("follows the link to /forgot-password and stores the login query", async () => {
    renderPage(null, true, "/login?client_id=acme&state=s1");
    await userEvent.click(
      await screen.findByRole("link", { name: "Forgot password?" })
    );

    expect(
      JSON.parse(window.localStorage.getItem("tereo.resetReturnTo") ?? "null")
    ).toMatchObject({ search: "?client_id=acme&state=s1" });
    expect(await screen.findByTestId("where")).toHaveTextContent(
      "/forgot-password?client_id=acme"
    );
  });

  it("offers no link, and no client_id=undefined, without a client_id", async () => {
    renderPage(null, true, "/login");

    await screen.findByText(/Invalid request/);
    expect(screen.queryByRole("link", { name: "Forgot password?" })).toBeNull();
    expect(document.body.innerHTML).not.toContain("undefined");
  });
});
