import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { GrantsPanel } from "./GrantsPanel";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const grant = {
  userId: "u1",
  email: "pat@example.com",
  name: "Pat",
  grantedBy: "u0",
  grantedAt: "2026-11-01T00:00:00Z",
};

const renderPanel = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <GrantsPanel clientId="c1" />
    </QueryClientProvider>
  );

beforeEach(() => {
  authMock.permissions = ["branding.admin"];
  authMock.axios.get.mockReset();
  authMock.axios.post.mockReset();
  authMock.axios.delete.mockReset();
  authMock.axios.get.mockResolvedValue({ data: { data: [grant] } });
  authMock.axios.post.mockResolvedValue({ data: {} });
  authMock.axios.delete.mockResolvedValue({ data: {} });
});

describe("GrantsPanel", () => {
  it("lists grants and revokes one", async () => {
    renderPanel();
    expect(await screen.findByText("pat@example.com")).toBeInTheDocument();
    expect(authMock.axios.get).toHaveBeenCalledWith(
      "/v1/admin/branding/clients/c1/grants"
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Revoke pat@example.com" }));
    await waitFor(() =>
      expect(authMock.axios.delete).toHaveBeenCalledWith(
        "/v1/admin/branding/clients/c1/grants/u1"
      )
    );
  });

  it("grants by user id when the viewer cannot search users", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("pat@example.com");
    const grantButton = screen.getByRole("button", { name: "Grant" });
    expect(grantButton).toBeDisabled();
    await user.type(screen.getByLabelText("User ID"), "u2");
    await user.click(grantButton);
    await waitFor(() =>
      expect(authMock.axios.post).toHaveBeenCalledWith(
        "/v1/admin/branding/clients/c1/grants",
        { userId: "u2" }
      )
    );
  });

  it("offers the user picker when the viewer can search users", async () => {
    authMock.permissions = ["branding.admin", "users.read"];
    renderPanel();
    await screen.findByText("pat@example.com");
    expect(screen.queryByLabelText("User ID")).toBeNull();
    expect(screen.getByText("User")).toBeInTheDocument();
  });
});
