import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChangePasswordPage } from "./ChangePasswordPage";
import userEvent from "@testing-library/user-event";
import { authMock } from "@/test/authMock";
import { StrictMode } from "react";
import { AxiosError } from "axios";

const redirect = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({ usePublicAxios: () => authMock.axios }));
vi.mock("../../api/redirectTo", () => ({ redirectTo: redirect }));

const coreError = (status: number, data: object) =>
  new AxiosError("Request failed", undefined, undefined, undefined, {
    status,
    data,
  } as never);

const URL_ =
  "/login/change-password?change_grant=g1&client_id=c1&redirect_uri=http%3A%2F%2Fapp%2Fcb&state=s&code_challenge=cc&code_challenge_method=S256&prompt=&max_age=";

const renderPage = (url = URL_) =>
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route
              path="/login/change-password"
              element={<ChangePasswordPage />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>
  );

const fill = async (user: ReturnType<typeof userEvent.setup>, pw: string) => {
  await user.type(screen.getByLabelText(/^New password/), pw);
  await user.type(screen.getByLabelText(/^Confirm password/), pw);
};

beforeEach(() => {
  authMock.axios.post.mockReset();
  redirect.mockReset();
});

describe("ChangePasswordPage", () => {
  it("posts the grant once on a double submit, then restarts authorize with the OAuth params", async () => {
    const user = userEvent.setup();
    authMock.axios.post.mockResolvedValue({ data: undefined });
    renderPage();

    await fill(user, "N3w-pass-phrase!");
    const button = screen.getByRole("button", { name: "Change password" });
    await user.dblClick(button);

    await waitFor(() => expect(redirect).toHaveBeenCalledTimes(1));
    expect(authMock.axios.post).toHaveBeenCalledTimes(1);
    expect(authMock.axios.post).toHaveBeenCalledWith(
      "/oauth/password-change",
      { change_grant: "g1", password: "N3w-pass-phrase!" },
      expect.objectContaining({ withCredentials: true })
    );
    const target = new URL(redirect.mock.calls[0][0] as string);
    expect(target.pathname).toBe("/oauth/authorize");
    expect(Object.fromEntries(target.searchParams)).toEqual({
      client_id: "c1",
      redirect_uri: "http://app/cb",
      state: "s",
      code_challenge: "cc",
      code_challenge_method: "S256",
      response_type: "code",
    });
  });

  it("shows password_unchanged inline and allows a retry", async () => {
    const user = userEvent.setup();
    authMock.axios.post.mockRejectedValueOnce(
      coreError(400, {
        error: "password_unchanged",
        error_description: "Choose a different password",
      })
    );
    renderPage();

    await fill(user, "same-as-before");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(
      await screen.findByText("Choose a different password")
    ).toBeVisible();

    authMock.axios.post.mockResolvedValueOnce({ data: undefined });
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(redirect).toHaveBeenCalledTimes(1));
  });

  it("shows Session Expired when the grant has expired", async () => {
    const user = userEvent.setup();
    authMock.axios.post.mockRejectedValue(
      coreError(400, { error: "invalid_session", error_description: "Gone" })
    );
    renderPage();

    await fill(user, "N3w-pass-phrase!");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByText("Session Expired")).toBeVisible();
  });

  it("shows Session Expired without a grant", () => {
    renderPage("/login/change-password?client_id=c1");

    expect(screen.getByText("Session Expired")).toBeVisible();
  });
});
