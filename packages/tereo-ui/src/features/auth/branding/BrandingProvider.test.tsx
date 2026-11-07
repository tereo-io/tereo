import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { BrandingProvider } from "./BrandingProvider";
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

  it("provides the override", () => {
    render(
      <BrandingProvider override={makeBranding({ appName: "Preview" })}>
        <Probe />
      </BrandingProvider>
    );
    expect(screen.getByTestId("name")).toHaveTextContent("Preview");
    expect(authMock.axios.get).not.toHaveBeenCalled();
  });
});
