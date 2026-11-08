import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { BrandingProvider } from "./BrandingProvider";
import { BrandedAuthPage } from "./BrandedAuthPage";
import { useBranding } from "./useBranding";
import { authMock } from "@/test/authMock";
import { makeBranding } from "./fixtures";

vi.mock("@/lib/auth", () => ({ usePublicAxios: () => authMock.axios }));

const Probe = () => (
  <div data-testid="name">{useBranding()?.appName ?? "none"}</div>
);

const inject = (value: unknown) => {
  const el = document.createElement("script");
  el.type = "application/json";
  el.id = "tereo-branding";
  el.textContent = JSON.stringify(value);
  document.head.appendChild(el);
};

beforeEach(() => {
  authMock.axios.get.mockReset();
  window.history.pushState({}, "", "/login?client_id=acme");
});
afterEach(() => {
  document.getElementById("tereo-branding")?.remove();
  document.getElementById("tereo-branding-style")?.remove();
  vi.useRealTimers();
});

describe("BrandingProvider", () => {
  it("uses the injected block without a request", () => {
    inject(makeBranding({ appName: "Injected" }));
    render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>
    );
    expect(screen.getByTestId("name")).toHaveTextContent("Injected");
    expect(authMock.axios.get).not.toHaveBeenCalled();
  });

  it("fetches with the URL's client_id when nothing was injected", async () => {
    authMock.axios.get.mockResolvedValue({
      data: makeBranding({ appName: "Fetched" }),
    });
    render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId("name")).toHaveTextContent("Fetched")
    );
    expect(authMock.axios.get).toHaveBeenCalledWith(
      "/oauth/branding",
      expect.objectContaining({ params: { client_id: "acme" } })
    );
  });

  it("gives up after 1500 ms and renders children unbranded", () => {
    vi.useFakeTimers();
    authMock.axios.get.mockReturnValue(new Promise(() => {}));
    const { container } = render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>
    );
    expect(container.querySelector(".t-brand-loading")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId("name")).toHaveTextContent("none");
  });

  it("sets the tab title and favicon from fetched branding, and restores them", async () => {
    document.title = "Tereo";
    const stock = document.createElement("link");
    stock.rel = "icon";
    stock.href = "/favicon.ico";
    document.head.appendChild(stock);
    authMock.axios.get.mockResolvedValue({
      data: makeBranding({
        appName: "Fetched",
        faviconUrl: "/oauth/branding/assets/f.png",
      }),
    });
    const { unmount } = render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>
    );
    await waitFor(() => expect(document.title).toBe("Fetched"));
    const icons = document.head.querySelectorAll('link[rel="icon"]');
    expect(icons).toHaveLength(1);
    expect(icons[0].getAttribute("href")).toContain(
      "/oauth/branding/assets/f.png"
    );
    unmount();
    expect(document.title).toBe("Tereo");
    expect(document.head.querySelector('link[rel="icon"]')).toBe(stock);
    stock.remove();
  });

  it("provides the override", () => {
    render(
      <BrandingProvider override={makeBranding({ appName: "Preview" })}>
        <Probe />
      </BrandingProvider>
    );
    expect(screen.getByTestId("name")).toHaveTextContent("Preview");
    expect(authMock.axios.get).not.toHaveBeenCalled();
  });

  it("treats an injected null as no branding, with no request or loader", () => {
    inject(null);
    const { container } = render(
      <BrandingProvider>
        <BrandedAuthPage>x</BrandedAuthPage>
      </BrandingProvider>
    );
    expect(screen.getByRole("heading")).toHaveTextContent("Tereo");
    expect(container.querySelector(".t-brand-loading")).toBeNull();
    expect(authMock.axios.get).not.toHaveBeenCalled();
  });

  it("fetches when the injected block is unparseable", async () => {
    const el = document.createElement("script");
    el.id = "tereo-branding";
    el.textContent = "5";
    document.head.appendChild(el);
    authMock.axios.get.mockResolvedValue({ data: null });
    render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId("name")).toHaveTextContent("none")
    );
    expect(authMock.axios.get).toHaveBeenCalled();
  });

  it("renders unbranded on a malformed 200 payload", async () => {
    authMock.axios.get.mockResolvedValue({ data: "<html>oops</html>" });
    render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId("name")).toHaveTextContent("none")
    );
  });

  it("tolerates a payload without colour maps", async () => {
    authMock.axios.get.mockResolvedValue({
      data: { scope: "auth", appName: "Bare" },
    });
    render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId("name")).toHaveTextContent("Bare")
    );
  });

  it("renders unbranded when the request fails", async () => {
    authMock.axios.get.mockRejectedValue(new Error("boom"));
    render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId("name")).toHaveTextContent("none")
    );
  });

  it("omits client_id when the URL has none", async () => {
    window.history.pushState({}, "", "/login");
    authMock.axios.get.mockResolvedValue({ data: null });
    render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId("name")).toHaveTextContent("none")
    );
    expect(authMock.axios.get).toHaveBeenCalledWith(
      "/oauth/branding",
      expect.objectContaining({ params: undefined })
    );
  });

  it("keeps fetched light colours off dark pages and drops unsafe values", async () => {
    authMock.axios.get.mockResolvedValue({
      data: makeBranding({
        colorsLight: {
          "--k-primary-color": "#112233",
          "--k-danger-color": "url(//evil.test/a)",
        },
        colorsDark: { "--k-primary-color": "oklch(0.6 0.2 30)" },
      }),
    });
    render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>
    );
    await waitFor(() =>
      expect(document.getElementById("tereo-branding-style")).not.toBeNull()
    );
    expect(document.getElementById("tereo-branding-style")?.textContent).toBe(
      ':root:not([data-theme="dark"]){--k-primary-color:#112233;}' +
        '[data-theme="dark"]{--k-primary-color:oklch(0.6 0.2 30);}'
    );
  });
});
