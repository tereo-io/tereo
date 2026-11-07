import { render, screen } from "@testing-library/react";
import { BrandingProvider } from "./BrandingProvider";
import { BrandedAuthPage } from "./BrandedAuthPage";
import { describe, expect, it, vi } from "vitest";
import type { EffectiveBranding } from "./types";
import { makeBranding } from "./fixtures";

vi.mock("@/lib/auth", () => ({ usePublicAxios: () => ({ get: vi.fn() }) }));

const renderWith = (branding: EffectiveBranding | null) =>
  render(
    <BrandingProvider override={branding}>
      <BrandedAuthPage>body</BrandedAuthPage>
    </BrandingProvider>
  );

describe("BrandedAuthPage", () => {
  it("is plain Tereo without branding", () => {
    renderWith(null);
    expect(screen.getByRole("heading")).toHaveTextContent("Tereo");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows the app name, logo, layout and footer links", () => {
    const { container } = renderWith(
      makeBranding({
        layout: "split",
        logoUrl: "/oauth/branding/assets/a.png",
        logoDarkUrl: "/oauth/branding/assets/b.png",
        footerLinks: [{ label: "Privacy", url: "https://acme.test/privacy" }],
      })
    );
    expect(screen.getByRole("heading")).toHaveTextContent("Acme");
    expect(screen.getByRole("img")).toHaveAttribute("alt", "Acme");
    expect(
      container.querySelector('source[media="(prefers-color-scheme: dark)"]')
    ).toHaveAttribute("srcset", "/oauth/branding/assets/b.png");
    const link = screen.getByRole("link", { name: "Privacy" });
    expect(link).toHaveAttribute("href", "https://acme.test/privacy");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
    expect(
      container.querySelector('[data-brand-layout="split"]')
    ).not.toBeNull();
  });

  it("ignores logo and links in console scope", () => {
    renderWith(
      makeBranding({
        scope: "console",
        logoUrl: "/x.png",
        footerLinks: [{ label: "A", url: "https://a.test" }],
      })
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
