import RegenerateIntegrationSecretButton from "./RegenerateIntegrationSecretButton";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { Integration } from "../../api/types";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () => ({
  ...(await import("@/test/authMock")).mockAuthModule(),
  useAuth: () => ({ hasPermission: () => true }),
}));

const integration = { id: "i1", name: "Acme" } as Integration;

beforeEach(() => authMock.axios.post.mockReset());

describe("RegenerateIntegrationSecretButton", () => {
  it("drops the new secret once the admin has saved it", async () => {
    authMock.axios.post.mockResolvedValue({
      data: {
        clientId: "cid-1",
        clientSecret: "fresh-s3cret",
        previousSecretExpiresAt: null,
      },
    });
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <RegenerateIntegrationSecretButton integration={integration} />
      </QueryClientProvider>
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Regenerate Secret" })
    );
    await userEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await screen.findByText("Copy the secret now");
    await userEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(document.body.textContent).toContain("fresh-s3cret");

    await userEvent.click(
      screen.getByRole("button", { name: /saved these credentials/i })
    );
    await waitFor(() =>
      expect(document.body.textContent).not.toContain("fresh-s3cret")
    );
    expect(
      client
        .getMutationCache()
        .getAll()
        .some((m) =>
          JSON.stringify(m.state.data ?? "").includes("fresh-s3cret")
        )
    ).toBe(false);
  });
});
