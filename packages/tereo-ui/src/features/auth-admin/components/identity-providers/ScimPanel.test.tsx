import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMock } from "@/test/authMock";
import { ScimPanel } from "./ScimPanel";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const connection = {
  id: "c1",
  providerId: "p1",
  baseUrl: "https://core.example.com/scim/v2",
  isActive: true,
  lastUsedAt: "2026-11-10T10:00:00Z",
  managedUserCount: 0,
  tokens: [
    {
      id: "t1",
      createdAt: "2026-11-01T00:00:00Z",
      lastUsedAt: null,
      revokedAt: null as string | null,
    },
  ],
};

const notFound = () =>
  Object.assign(new Error("Not found"), {
    isAxiosError: true,
    response: { status: 404, data: { error: "not_found" } },
  });

const renderPanel = (conn: typeof connection | null) => {
  authMock.axios.get.mockImplementation(async () => {
    if (!conn) throw notFound();
    return { data: conn };
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ScimPanel providerId="p1" />
    </QueryClientProvider>
  );
  return client;
};

beforeEach(() => {
  authMock.permissions = ["admin"];
  Object.values(authMock.axios).forEach((fn) => fn.mockReset());
});

describe("ScimPanel", () => {
  it("offers Enable and no token controls without a connection", async () => {
    renderPanel(null);

    expect(
      await screen.findByRole("button", { name: "Enable SCIM" })
    ).toBeVisible();
    expect(
      screen.getByText(/lets this provider create, change and deactivate users/)
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Generate token" })).toBeNull();
  });

  it.each([
    ["a server error", 500],
    ["a refusal", 403],
    ["a network error", undefined],
  ])("offers no Enable after %s, only a retry", async (_, status) => {
    authMock.axios.get.mockRejectedValue(
      Object.assign(new Error("Request failed"), {
        isAxiosError: true,
        response: status === undefined ? undefined : { status, data: {} },
      })
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ScimPanel providerId="p1" />
      </QueryClientProvider>
    );

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText(/could not be loaded/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Enable SCIM" })).toBeNull();

    authMock.axios.get.mockResolvedValue({ data: connection });
    fireEvent.click(retry);
    expect(await screen.findByText(connection.baseUrl)).toBeVisible();
  });

  it("creates the connection with PUT", async () => {
    renderPanel(null);
    authMock.axios.put.mockResolvedValue({ data: connection });

    fireEvent.click(await screen.findByRole("button", { name: "Enable SCIM" }));

    await waitFor(() =>
      expect(authMock.axios.put).toHaveBeenCalledWith(
        "/v1/admin/identity-providers/p1/scim",
        { isActive: true }
      )
    );
  });

  it("shows the base URL, managed users and last used", async () => {
    renderPanel({ ...connection, managedUserCount: 3 });

    expect(await screen.findByText(connection.baseUrl)).toBeVisible();
    expect(screen.getByText("3")).toBeVisible();
    expect(screen.getByText("Managed users")).toBeVisible();
    expect(screen.getAllByText("Last used").length).toBeGreaterThan(0);
  });

  it("shows a new token once", async () => {
    renderPanel(connection);
    authMock.axios.post.mockResolvedValue({
      data: {
        id: "t2",
        token: "scim_secret_value",
        createdAt: "2026-11-11T00:00:00Z",
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Generate token" })
    );

    expect(await screen.findByText("scim_secret_value")).toBeVisible();
    expect(authMock.axios.post).toHaveBeenCalledWith(
      "/v1/admin/identity-providers/p1/scim/tokens"
    );

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByText("scim_secret_value")).toBeNull()
    );
  });

  it("keeps the token in no mutation after the modal closes", async () => {
    const client = renderPanel(connection);
    authMock.axios.post.mockResolvedValue({
      data: {
        id: "t2",
        token: "scim_secret_value",
        createdAt: "2026-11-11T00:00:00Z",
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Generate token" })
    );
    await screen.findByText("scim_secret_value");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() =>
      expect(screen.queryByText("scim_secret_value")).toBeNull()
    );
    const held = client
      .getMutationCache()
      .getAll()
      .filter((m) =>
        JSON.stringify(m.state.data ?? null).includes("scim_secret")
      );
    expect(held).toEqual([]);
  });

  it("disables Generate at two live tokens", async () => {
    const rest = { createdAt: "2026-11-01T00:00:00Z", lastUsedAt: null };
    renderPanel({
      ...connection,
      tokens: [
        { id: "t1", revokedAt: null, ...rest },
        { id: "t2", revokedAt: null, ...rest },
        { id: "t3", revokedAt: "2026-11-02T00:00:00Z", ...rest },
      ],
    });

    expect(
      await screen.findByRole("button", { name: "Generate token" })
    ).toBeDisabled();
    expect(screen.getByText(/two live tokens/i)).toBeVisible();
  });

  it("revokes a token after confirmation", async () => {
    renderPanel(connection);
    authMock.axios.delete.mockResolvedValue({});

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Revoke token" })
    );

    await waitFor(() =>
      expect(authMock.axios.delete).toHaveBeenCalledWith(
        "/v1/admin/identity-providers/p1/scim/tokens/t1"
      )
    );
  });

  it("disables Remove with a reason while users are managed", async () => {
    renderPanel({ ...connection, managedUserCount: 2 });

    expect(
      await screen.findByRole("button", { name: "Remove SCIM" })
    ).toBeDisabled();
    expect(screen.getByText(/Unlink its users first/)).toBeVisible();
  });

  it("removes the connection after confirmation", async () => {
    renderPanel(connection);
    authMock.axios.delete.mockResolvedValue({});

    fireEvent.click(await screen.findByRole("button", { name: "Remove SCIM" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove connection" })
    );

    await waitFor(() =>
      expect(authMock.axios.delete).toHaveBeenCalledWith(
        "/v1/admin/identity-providers/p1/scim"
      )
    );
  });

  it("shows no write controls without identity-providers.write", async () => {
    authMock.permissions = ["identity-providers.read"];
    renderPanel(connection);

    await screen.findByText(connection.baseUrl);
    expect(screen.queryByRole("button", { name: "Generate token" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove SCIM" })).toBeNull();
  });
});
