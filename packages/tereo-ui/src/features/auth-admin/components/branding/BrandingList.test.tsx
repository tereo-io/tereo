import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { BrandingList } from "./BrandingList";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const entry = {
  id: "c1",
  clientId: "web-app",
  name: "Web App",
  provisioned: false,
  updatedAt: "2026-11-01T00:00:00Z",
};

const renderList = (data: unknown) => {
  authMock.axios.get.mockResolvedValue({ data });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <BrandingList />
      </MemoryRouter>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  authMock.permissions = ["branding.read"];
  authMock.axios.get.mockReset();
});

describe("BrandingList", () => {
  it("shows Default first when the API returns it", async () => {
    renderList({
      default: { provisioned: false, updatedAt: "2026-11-01T00:00:00Z" },
      clients: [entry],
    });
    const links = await screen.findAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Default", "Web App"]);
  });

  it("omits Default when the API does not return it", async () => {
    renderList({ default: null, clients: [entry] });
    await screen.findByText("Web App");
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
  });

  it("offers Brand a client only with branding.write", async () => {
    renderList({ default: null, clients: [entry] });
    await screen.findByText("Web App");
    expect(screen.queryByText("Brand a client…")).not.toBeInTheDocument();
  });

  it("offers the clients core lists as brandable, without reading the clients list", async () => {
    authMock.permissions = ["branding.read", "branding.write"];
    const user = userEvent.setup();
    renderList({
      default: null,
      clients: [entry],
      brandable: [
        { id: "c2", clientId: "early-app", name: "Early App" },
        { id: "c3", clientId: "granted-app", name: "Granted App" },
      ],
    });
    await user.click(await screen.findByText("Brand a client…"));
    expect(
      await screen.findByRole("option", { name: "Early App (early-app)" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Granted App (granted-app)" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Web App/ })
    ).not.toBeInTheDocument();
    expect(authMock.axios.get).toHaveBeenCalledTimes(1);
    expect(authMock.axios.get).toHaveBeenCalledWith("/v1/admin/branding");
  });

  it("says so when there is nothing left to brand", async () => {
    authMock.permissions = ["branding.read", "branding.write"];
    const user = userEvent.setup();
    renderList({ default: null, clients: [entry], brandable: [] });
    await user.click(await screen.findByText("Brand a client…"));
    expect(
      await screen.findByText(
        "Every client you may brand already has branding."
      )
    ).toBeInTheDocument();
  });

  it("shows an error with a retry, not 'No branding yet', when loading fails", async () => {
    authMock.permissions = ["branding.read", "branding.write"];
    authMock.axios.get.mockRejectedValue(new Error("boom"));
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <BrandingList />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(await screen.findByText("Could not load branding")).toBeVisible();
    expect(screen.queryByText("No branding yet")).toBeNull();
    expect(screen.queryByText("Brand a client…")).toBeNull();

    authMock.axios.get.mockResolvedValue({
      data: { default: null, clients: [entry] },
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Web App")).toBeVisible();
  });
});
