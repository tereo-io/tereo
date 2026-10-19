import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OAuthClient } from "../../api/oauth-clients/types";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClientDetail } from "./ClientDetail";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () => ({
  ...(await import("@/test/authMock")).mockAuthModule(),
  useAuth: () => ({ hasPermission: () => true, user: { sub: "u1" } }),
}));

const client: OAuthClient = {
  id: "c1",
  clientId: "web-app",
  clientType: "confidential",
  name: "Web App",
  redirectUris: [],
  postLogoutRedirectUris: [],
  scopes: [],
  grantTypes: ["authorization_code"],
  audience: ["billing"],
  trustedCoreScopes: [],
  consentRequired: false,
  provisioned: false,
  unprovisionedAt: null,
  ownerId: "u1",
  service: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

const renderDetail = (data: OAuthClient) => {
  authMock.axios.get.mockResolvedValue({ data });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/clients/c1"]}>
        <Routes>
          <Route path="/clients/:clientId" element={<ClientDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

beforeEach(() => authMock.axios.get.mockReset());

describe("ClientDetail", () => {
  it("shows the audience and that users are not asked to approve", async () => {
    renderDetail(client);

    expect(await screen.findByText("billing")).toBeInTheDocument();
    expect(screen.getByText("User approval")).toBeInTheDocument();
    expect(screen.getByText("Not asked")).toBeInTheDocument();
  });

  it("shows the core scopes the client is trusted with", async () => {
    renderDetail({ ...client, trustedCoreScopes: ["core:events"] });

    expect(await screen.findByText("Trusted core scopes")).toBeVisible();
    expect(screen.getByText("core:events")).toBeVisible();
  });

  it("shows that users are asked to approve", async () => {
    renderDetail({ ...client, consentRequired: true });

    expect(await screen.findByText("Asked")).toBeInTheDocument();
  });

  it("omits the consent row for core's own login client", async () => {
    renderDetail({ ...client, clientId: "tereo-ui" });

    await screen.findByText("Client Details");
    expect(screen.queryByText("User approval")).not.toBeInTheDocument();
  });

  it("offers edit, regenerate and delete on a hand-made client", async () => {
    renderDetail(client);

    await screen.findByText("Client Details");
    expect(screen.getByTitle("Edit")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /regenerate/i })
    ).toBeInTheDocument();
    expect(screen.getByTitle("Delete")).toBeInTheDocument();
    expect(
      screen.queryByText("Managed by provisioning")
    ).not.toBeInTheDocument();
  });

  it("badges a provisioned client and hides every change", async () => {
    renderDetail({ ...client, provisioned: true });

    expect(await screen.findByText("Managed by provisioning")).toBeVisible();
    expect(screen.queryByTitle("Edit")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /regenerate/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByTitle("Delete")).not.toBeInTheDocument();
  });
});
