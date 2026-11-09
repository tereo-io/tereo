import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForgotPasswordPage } from "./ForgotPasswordPage";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", () => ({ usePublicAxios: () => authMock.axios }));

beforeEach(() => {
  authMock.axios.post.mockReset();
  authMock.axios.post.mockResolvedValue({ data: undefined });
});

describe("ForgotPasswordPage", () => {
  it("submits the email with the login's client_id and shows the same message for any address", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/forgot-password?client_id=acme"]}>
          <Routes>
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await user.type(await screen.findByLabelText(/^Email/), "nobody@x.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(authMock.axios.post).toHaveBeenCalledWith("/v1/password-reset", {
      email: "nobody@x.com",
      client_id: "acme",
    });
    expect(
      await screen.findByText(
        "If an account exists for that address, we've sent a link."
      )
    ).toBeVisible();
  });

  const Where = () => {
    const l = useLocation();
    return <div data-testid="where">{l.pathname + l.search}</div>;
  };

  const renderWithState = (state: unknown) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter
          initialEntries={[{ pathname: "/forgot-password", state }]}
        >
          <Routes>
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/login" element={<Where />} />
            <Route path="/" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

  it("goes back to the sign-in it was opened from", async () => {
    renderWithState({ loginSearch: "?client_id=acme&state=s1" });
    await userEvent.click(
      await screen.findByRole("link", { name: "Back to sign in" })
    );

    expect(await screen.findByTestId("where")).toHaveTextContent(
      "/login?client_id=acme&state=s1"
    );
  });

  it.each([
    ["no login query", null],
    ["a query that is not one", { loginSearch: "//evil.example/" }],
  ])("with %s, goes back to /", async (_label, state) => {
    renderWithState(state);
    await userEvent.click(
      await screen.findByRole("link", { name: "Back to sign in" })
    );

    expect(await screen.findByTestId("where")).toHaveTextContent(/^\/$/);
  });
});
