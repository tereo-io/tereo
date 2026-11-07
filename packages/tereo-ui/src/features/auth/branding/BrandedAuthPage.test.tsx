import { render, screen } from "@testing-library/react";
import { BrandingProvider } from "./BrandingProvider";
import { BrandedAuthPage } from "./BrandedAuthPage";
import { describe, expect, it, vi } from "vitest";
import type { EffectiveBranding } from "./types";
import { makeBranding } from "./fixtures";
import { readFileSync } from "node:fs";
import env from "@/lib/env";

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
    expect(container.querySelector("picture, source[media]")).toBeNull();
    const logo = container.querySelector(".t-brand-logo");
    expect(logo).toHaveClass("t-brand-logo-has-dark");
    expect(logo?.querySelector(".t-brand-logo-light")).toHaveAttribute(
      "src",
      `${env.CORE_URL}/oauth/branding/assets/a.png`
    );
    expect(logo?.querySelector(".t-brand-logo-dark")).toHaveAttribute(
      "src",
      `${env.CORE_URL}/oauth/branding/assets/b.png`
    );
    for (const img of screen.getAllByRole("img")) {
      expect(img).toHaveAttribute("alt", "Acme");
    }
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

  it("drops unsafe URLs", () => {
    renderWith(
      makeBranding({
        logoUrl: "javascript:alert(1)",
        footerLinks: [
          { label: "Bad", url: "javascript:alert(1)" },
          { label: "Proto", url: "//evil.test" },
          { label: "Good", url: "https://ok.test" },
        ],
      })
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("link", { name: "Bad" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Proto" })).toBeNull();
    expect(screen.getByRole("link", { name: "Good" })).toBeInTheDocument();
  });

  it("renders one logo, for both themes, without a dark logo", () => {
    const { container } = renderWith(
      makeBranding({ logoUrl: "/oauth/branding/assets/a.png" })
    );
    const logo = container.querySelector(".t-brand-logo");
    expect(logo).not.toHaveClass("t-brand-logo-has-dark");
    expect(logo?.querySelectorAll("img")).toHaveLength(1);
  });

  it("resolves asset paths against core, not the page's origin", () => {
    const original = env.CORE_URL;
    env.CORE_URL = "http://localhost:4001";
    try {
      const { container } = renderWith(
        makeBranding({
          logoUrl: "/oauth/branding/assets/a.png",
          backgroundUrl: "/oauth/branding/assets/c.png",
        })
      );
      expect(screen.getByRole("img")).toHaveAttribute(
        "src",
        "http://localhost:4001/oauth/branding/assets/a.png"
      );
      expect(
        (container.querySelector(".t-brand-page") as HTMLElement).style
          .backgroundImage
      ).toContain("http://localhost:4001/oauth/branding/assets/c.png");
    } finally {
      env.CORE_URL = original;
    }
  });

  it("accepts core's own http origin, and no other http URL", () => {
    const original = env.CORE_URL;
    env.CORE_URL = "http://localhost:4001";
    try {
      renderWith(
        makeBranding({
          logoUrl: "http://localhost:4001/oauth/branding/assets/a.png",
        })
      );
      expect(screen.getByRole("img")).toBeInTheDocument();
    } finally {
      env.CORE_URL = original;
    }
    renderWith(makeBranding({ logoUrl: "http://evil.test/a.png" }));
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("puts a split background in its own column beside a solid form", () => {
    const { container } = renderWith(
      makeBranding({
        layout: "split",
        backgroundUrl: "/oauth/branding/assets/c.png",
      })
    );
    const page = container.querySelector(".t-brand-page") as HTMLElement;
    expect(page).toHaveClass("t-brand-split-with-image");
    expect(page.style.backgroundImage).toBe("");
    const image = screen.getByTestId("brand-split-image");
    expect(image.style.backgroundImage).toContain("c.png");
    expect(image).toHaveAttribute("aria-hidden", "true");
    expect(image.nextElementSibling).toHaveClass("t-brand-split-form");
    expect(
      image.nextElementSibling?.querySelector(".k-auth-page-card")
    ).not.toBeNull();
  });

  it("keeps a centred background on the page itself", () => {
    const { container } = renderWith(
      makeBranding({
        layout: "centered",
        backgroundUrl: "/oauth/branding/assets/c.png",
      })
    );
    const page = container.querySelector(".t-brand-page") as HTMLElement;
    expect(page.style.backgroundImage).toContain("c.png");
    expect(screen.queryByTestId("brand-split-image")).toBeNull();
  });

  it("drops a path that starts with a backslash after the slash", () => {
    renderWith(makeBranding({ logoUrl: "/\\evil.test/a.png" }));
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("picks the logo from the nearest data-theme, not the OS setting", () => {
    const css = readFileSync("src/features/auth/branding/styles.css", "utf8");
    expect(css).not.toContain("prefers-color-scheme");
    expect(css).toContain(
      '[data-theme="dark"] .t-brand-logo-has-dark .t-brand-logo-dark'
    );
  });
});
