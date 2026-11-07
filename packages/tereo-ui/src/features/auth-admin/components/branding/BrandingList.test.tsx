import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
