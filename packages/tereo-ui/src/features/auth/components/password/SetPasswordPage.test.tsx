import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { SetPasswordPage } from "./SetPasswordPage";
import { authMock } from "@/test/authMock";
import { AxiosError } from "axios";

vi.mock("@/lib/auth", () => ({ usePublicAxios: () => authMock.axios }));

const notFound = new AxiosError("nf", undefined, undefined, undefined, {
  status: 404,
  data: { error: "not_found" },
} as never);

const Where = () => {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
};

const renderAt = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/set-password" element={<SetPasswordPage />} />
          <Route path="/login" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  authMock.axios.post.mockReset();
});

describe("SetPasswordPage", () => {
  it("reads the token from the fragment, sets the password, and goes to login with the email", async () => {
    const user = userEvent.setup();
    authMock.axios.post.mockImplementation(async (path: string) =>
      path === "/v1/password-setup/inspect"
        ? {
            data: {
              email: "jane@customer.com",
              name: "Jane",
              expiresAt: "2026-11-09T00:00:00Z",
            },
          }
        : { data: undefined }
    );
    renderAt("/set-password#token=abc123");

    await user.type(
      await screen.findByLabelText(/^New password/),
      "Str0ng-pass-phrase"
    );
    await user.type(
      screen.getByLabelText(/^Confirm password/),
      "Str0ng-pass-phrase"
    );
    await user.click(screen.getByRole("button", { name: "Set password" }));

    expect(authMock.axios.post).toHaveBeenCalledWith(
      "/v1/password-setup/inspect",
      { token: "abc123" }
    );
    await waitFor(() =>
      expect(authMock.axios.post).toHaveBeenCalledWith("/v1/password-setup", {
        token: "abc123",
        password: "Str0ng-pass-phrase",
      })
    );
    expect(await screen.findByTestId("where")).toHaveTextContent(
      "/login?login_hint=jane%40customer.com"
    );
  });

  it("ignores a token in the query string", async () => {
    renderAt("/set-password?token=abc123");

    expect(
      await screen.findByText("This link is no longer valid")
    ).toBeVisible();
    expect(authMock.axios.post).not.toHaveBeenCalled();
  });

  it("shows the uniform message on a 404", async () => {
    authMock.axios.post.mockRejectedValue(notFound);
    renderAt("/set-password#token=gone");

    expect(
      await screen.findByText("This link is no longer valid")
    ).toBeVisible();
  });
});
