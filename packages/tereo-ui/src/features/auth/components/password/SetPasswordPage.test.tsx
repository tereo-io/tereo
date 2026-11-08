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
          <Route path="/" element={<Where />} />
          <Route path="/login" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  window.localStorage.clear();
  authMock.axios.post.mockReset();
});

describe("SetPasswordPage", () => {
  it("reads the token from the fragment, sets the password, and offers sign in", async () => {
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
    expect(await screen.findByText(/Your password is set/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByTestId("where")).toHaveTextContent(/^\/$/);
  });

  const DETAILS = {
    data: {
      email: "jane@customer.com",
      name: "Jane",
      expiresAt: "2026-11-09T00:00:00Z",
    },
  };

  const submitWith = async (failure: AxiosError) => {
    const user = userEvent.setup();
    authMock.axios.post.mockImplementation(async (path: string) => {
      if (path === "/v1/password-setup/inspect") return DETAILS;
      throw failure;
    });
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
  };

  it("shows the server's message when the password is refused", async () => {
    await submitWith(
      new AxiosError("bad", undefined, undefined, undefined, {
        status: 400,
        data: {
          error: "invalid_request",
          error_description: "Invalid request body. password: Too weak",
          issues: [{ path: "password", message: "Too weak" }],
        },
      } as never)
    );

    expect(await screen.findByText("Too weak")).toBeVisible();
    expect(screen.queryByText("This link is no longer valid")).toBeNull();
  });

  it("shows the uniform message when the link fails on set", async () => {
    await submitWith(
      new AxiosError("nf", undefined, undefined, undefined, {
        status: 404,
        data: { error: "not_found", error_description: "Not found" },
      } as never)
    );

    expect(
      await screen.findByText("This link is no longer valid")
    ).toBeVisible();
    expect(screen.queryByText("Not found")).toBeNull();
  });

  it.each([429, 503])(
    "asks to try again shortly when the set fails with %i",
    async (status) => {
      await submitWith(
        new AxiosError("busy", undefined, undefined, undefined, {
          status,
          data: { error: "rate_limited" },
        } as never)
      );

      expect(await screen.findByText(/Try again shortly/)).toBeVisible();
      expect(screen.queryByText("This link is no longer valid")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Set password" })
      ).toBeVisible();
    }
  );

  it.each([429, 503])(
    "offers a retry when the inspect fails with %i",
    async (status) => {
      const user = userEvent.setup();
      authMock.axios.post.mockRejectedValueOnce(
        new AxiosError("busy", undefined, undefined, undefined, {
          status,
          data: { error: "rate_limited" },
        } as never)
      );
      authMock.axios.post.mockResolvedValueOnce(DETAILS);
      renderAt("/set-password#token=abc123");

      expect(await screen.findByText(/Try again shortly/)).toBeVisible();
      expect(screen.queryByText("This link is no longer valid")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByLabelText(/^New password/)).toBeVisible();
    }
  );

  const resetDetails = { data: { ...DETAILS.data, purpose: "reset" } };

  const completeReset = async () => {
    const user = userEvent.setup();
    authMock.axios.post.mockImplementation(async (path: string) =>
      path === "/v1/password-setup/inspect" ? resetDetails : { data: undefined }
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
    return user;
  };

  it("titles a reset link 'Reset your password'", async () => {
    authMock.axios.post.mockResolvedValue(resetDetails);
    renderAt("/set-password#token=abc123");

    expect(await screen.findByText("Reset your password")).toBeVisible();
  });

  it("Sign in returns to the stored login query after a reset", async () => {
    window.localStorage.setItem(
      "tereo.resetReturnTo",
      JSON.stringify({ search: "?client_id=c1&state=s", savedAt: Date.now() })
    );
    const user = await completeReset();
    await user.click(await screen.findByRole("button", { name: "Sign in" }));

    expect(await screen.findByTestId("where")).toHaveTextContent(
      "/login?client_id=c1&state=s"
    );
    expect(window.localStorage.getItem("tereo.resetReturnTo")).toBeNull();
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
