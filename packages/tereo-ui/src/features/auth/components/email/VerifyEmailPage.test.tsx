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

const failed = (status: number) =>
  new AxiosError(String(status), undefined, undefined, undefined, {
    status,
    data: { error: status === 404 ? "not_found" : "rate_limited" },
  } as never);
const notFound = () => failed(404);

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

  it("a 404 on confirm shows the expired-link message and disables the button", async () => {
    const user = userEvent.setup();
    authMock.axios.post.mockImplementation(async (path: string) => {
      if (path === "/v1/email-verification/inspect")
        return {
          data: { email: "ada@example.com", expiresAt: "2026-11-12T00:00:00Z" },
        };
      throw notFound();
    });
    renderAt("/verify-email#token=abc");

    await user.click(
      await screen.findByRole("button", { name: "Confirm my email" })
    );

    expect(
      await screen.findByText(/no longer valid or has expired/)
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Confirm my email" })
    ).toBeDisabled();
  });

  it.each([429, 503])(
    "a %i on confirm says try again and keeps the button enabled",
    async (status) => {
      const user = userEvent.setup();
      let attempts = 0;
      authMock.axios.post.mockImplementation(async (path: string) => {
        if (path === "/v1/email-verification/inspect")
          return {
            data: {
              email: "ada@example.com",
              expiresAt: "2026-11-12T00:00:00Z",
            },
          };
        attempts++;
        if (attempts === 1) throw failed(status);
        return { data: undefined };
      });
      renderAt("/verify-email#token=abc");

      await user.click(
        await screen.findByRole("button", { name: "Confirm my email" })
      );

      expect(await screen.findByText(/Try again shortly/)).toBeVisible();
      const button = screen.getByRole("button", { name: "Confirm my email" });
      expect(button).toBeEnabled();

      await user.click(button);
      expect(
        await screen.findByText("Your email address is confirmed.")
      ).toBeVisible();
    }
  );
});
