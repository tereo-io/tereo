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

  it("offers Brand a client with branding.write and pages through every client", async () => {
    authMock.permissions = ["branding.read", "branding.write"];
    const user = userEvent.setup();
    authMock.axios.get.mockImplementation(async (url: string) => {
      if (url.startsWith("/v1/admin/branding"))
        return { data: { default: null, clients: [entry] } };
      return url.includes("cursor=p2")
        ? {
            data: {
              data: [{ id: "c3", clientId: "late-app", name: "Late App" }],
              hasMore: false,
              nextCursor: null,
            },
          }
        : {
            data: {
              data: [
                { id: "c1", clientId: "web-app", name: "Web App" },
                { id: "c2", clientId: "early-app", name: "Early App" },
              ],
              hasMore: true,
              nextCursor: "p2",
            },
          };
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <BrandingList />
        </MemoryRouter>
      </QueryClientProvider>
    );
    await user.click(await screen.findByText("Brand a client…"));
    await screen.findByRole("option", { name: "Early App (early-app)" });
    expect(
      screen.queryByRole("option", { name: /Web App/ })
    ).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", { name: "Load more clients" })
    );
    expect(
      await screen.findByRole("option", { name: "Late App (late-app)" })
    ).toBeInTheDocument();
  });
});
