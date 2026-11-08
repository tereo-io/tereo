import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { VerifyEmailPage } from "./VerifyEmailPage";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { authMock } from "@/test/authMock";
import { AxiosError } from "axios";

vi.mock("@/lib/auth", () => ({ usePublicAxios: () => authMock.axios }));

const renderAt = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <VerifyEmailPage />
      </MemoryRouter>
    </QueryClientProvider>
  );

const notFound = () =>
  new AxiosError("nf", undefined, undefined, undefined, {
    status: 404,
    data: { error: "not_found" },
  } as never);

beforeEach(() => {
  authMock.axios.post.mockReset();
});

describe("VerifyEmailPage", () => {
  it("does not confirm on load; confirms on click", async () => {
    const user = userEvent.setup();
    authMock.axios.post.mockImplementation(async (path: string) =>
      path === "/v1/email-verification/inspect"
        ? {
            data: {
              email: "ada@example.com",
              expiresAt: "2026-11-12T00:00:00Z",
            },
          }
        : { data: undefined }
    );
    renderAt("/verify-email#token=abc");

    expect(await screen.findByText("ada@example.com")).toBeVisible();
    expect(authMock.axios.post).not.toHaveBeenCalledWith(
      "/v1/email-verification",
      expect.anything()
    );

    await user.click(screen.getByRole("button", { name: "Confirm my email" }));

    expect(authMock.axios.post).toHaveBeenCalledWith("/v1/email-verification", {
      token: "abc",
    });
    expect(
      await screen.findByText("Your email address is confirmed.")
    ).toBeVisible();
  });

  it("a 404 shows the expired-link message", async () => {
    authMock.axios.post.mockRejectedValue(notFound());
    renderAt("/verify-email#token=gone");

    expect(
      await screen.findByText(/no longer valid or has expired/)
    ).toBeVisible();
  });
});
