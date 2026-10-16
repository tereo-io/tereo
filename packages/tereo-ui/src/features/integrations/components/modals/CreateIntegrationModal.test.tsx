import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import CreateIntegrationModal from "./CreateIntegrationModal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () => ({
  ...(await import("@/test/authMock")).mockAuthModule(),
  useAuth: () => ({ hasPermission: () => true }),
}));

beforeEach(() => {
  authMock.axios.get.mockReset();
  authMock.axios.get.mockResolvedValue({
    data: { data: [], hasMore: false, limit: 100, nextCursor: null },
  });
  authMock.axios.post.mockReset();
});

describe("CreateIntegrationModal", () => {
  it("shows the client secret once, after creating", async () => {
    authMock.axios.post.mockResolvedValue({
      data: {
        id: "i1",
        name: "Acme",
        credentials: { clientId: "cid-1", clientSecret: "s3cret-value" },
      },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <CreateIntegrationModal show onClose={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await userEvent.type(screen.getByLabelText(/^Name/), "Acme");
    await userEvent.click(
      screen.getByRole("button", { name: "Add Integration" })
    );

    expect(await screen.findByText("Copy the secret now")).toBeVisible();
    expect(authMock.axios.post).toHaveBeenCalledWith("/v1/admin/integrations", {
      name: "Acme",
    });
    await userEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(document.body.textContent).toContain("s3cret-value");
    await userEvent.click(
      screen.getByRole("button", { name: /saved these credentials/i })
    );
    await waitFor(() =>
      expect(document.body.textContent).not.toContain("s3cret-value")
    );
  });

  it("still shows the secret when the dialog is closed while the request is in flight", async () => {
    let resolve: (v: unknown) => void = () => {};
    authMock.axios.post.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <CreateIntegrationModal show onClose={onClose} />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await userEvent.type(screen.getByLabelText(/^Name/), "Acme");
    await userEvent.click(
      screen.getByRole("button", { name: "Add Integration" })
    );
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).not.toHaveBeenCalled();
    resolve({
      data: {
        id: "i1",
        name: "Acme",
        credentials: { clientId: "cid-1", clientSecret: "s3cret-value" },
      },
    });

    expect(await screen.findByText("Copy the secret now")).toBeVisible();
  });
});
