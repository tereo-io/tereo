import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
});
