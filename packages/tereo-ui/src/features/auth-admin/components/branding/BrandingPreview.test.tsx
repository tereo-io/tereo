import type { EffectiveBranding } from "@/features/auth";
import { render, screen } from "@testing-library/react";
import { emptyDraft } from "../../api/branding/types";
import { BrandingPreview } from "./BrandingPreview";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { STOCK_COLORS } from "@/features/auth";
import { readFileSync } from "node:fs";
import env from "@/lib/env";

vi.mock("@/lib/auth", () => ({
  usePublicAxios: () => ({ get: vi.fn() }),
}));

const inherited: EffectiveBranding = {
  scope: "auth",
  appName: null,
  headline: null,
  subtitle: null,
  signInLabel: null,
  notice: null,
  layout: null,
  footerLinks: null,
  colorsLight: {
    "--k-primary-color": "#111111",
    "--k-danger-color": "#aa0000",
  },
  colorsDark: { "--k-primary-color": "#eeeeee" },
  logoUrl: null,
  logoDarkUrl: null,
  faviconUrl: null,
  backgroundUrl: null,
  applyToConsole: false,
};

const draft = {
  ...emptyDraft(),
  appName: "Draft Co",
  colorsLight: { "--k-primary-color": "#00bb55" },
  colorsDark: { "--k-primary-color": "#ff00ff" },
};

describe("BrandingPreview", () => {
  it("shows the unsaved app name and draft colours on the frame only", () => {
    render(<BrandingPreview draft={draft} inherited={inherited} />);
    expect(
      screen.getByRole("heading", { name: "Draft Co" })
    ).toBeInTheDocument();
    const frame = screen.getByTestId("branding-preview-frame");
    expect(frame.getAttribute("style")).toContain("--k-primary-color: #00bb55");
    // Colours the draft does not set come from the inherited values.
    expect(frame.getAttribute("style")).toContain("--k-danger-color: #aa0000");
    expect(frame).toHaveAttribute("data-theme", "light");
    expect(
      document.documentElement.style.getPropertyValue("--k-primary-color")
    ).toBe("");
  });

  it("sets stock light colours on the frame inside a dark console", () => {
    render(
      <div data-theme="dark">
        <BrandingPreview
          draft={emptyDraft()}
          inherited={{ ...inherited, colorsLight: {}, colorsDark: {} }}
        />
      </div>
    );
    const style = screen
      .getByTestId("branding-preview-frame")
      .getAttribute("style");
    expect(style).toContain(
      `--k-primary-color: ${STOCK_COLORS.light["--k-primary-color"]}`
    );
    expect(STOCK_COLORS.light["--k-primary-color"]).not.toBe(
      STOCK_COLORS.dark["--k-primary-color"]
    );
  });

  it("switches to the dark colours", async () => {
    render(<BrandingPreview draft={draft} inherited={inherited} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Dark" }));
    const frame = screen.getByTestId("branding-preview-frame");
    expect(frame).toHaveAttribute("data-theme", "dark");
    expect(frame.getAttribute("style")).toContain("--k-primary-color: #ff00ff");
    expect(frame.getAttribute("style")).not.toContain("#00bb55");
  });

  it("renders the consent step inside the branded shell", async () => {
    render(<BrandingPreview draft={draft} inherited={inherited} />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Consent" }));
    const frame = screen.getByTestId("branding-preview-frame");
    expect(frame.querySelector(".k-auth-page")).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Authorization Request" })
    ).toBeInTheDocument();
  });

  it("switches the layout and uses uploaded image urls", async () => {
    const { container } = render(
      <BrandingPreview
        inherited={inherited}
        draft={{
          ...draft,
          logo: { sha256: "a", url: "/oauth/branding/assets/logo.png" },
        }}
      />
    );
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      `${env.CORE_URL}/oauth/branding/assets/logo.png`
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Split" }));
    expect(
      container.querySelector("[data-brand-layout='split']")
    ).not.toBeNull();
  });

  it("loads uploaded images from core and shows the dark logo in the dark frame", async () => {
    const { container } = render(
      <BrandingPreview
        inherited={inherited}
        draft={{
          ...draft,
          logo: { sha256: "a", url: "/oauth/branding/assets/a.png" },
          logoDark: { sha256: "b", url: "/oauth/branding/assets/b.png" },
        }}
      />
    );
    const frame = screen.getByTestId("branding-preview-frame");
    expect(frame.querySelector(".t-brand-logo-light")).toHaveAttribute(
      "src",
      `${env.CORE_URL}/oauth/branding/assets/a.png`
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Dark" }));
    expect(frame).toHaveAttribute("data-theme", "dark");
    expect(container.querySelector(".t-brand-logo")).toHaveClass(
      "t-brand-logo-has-dark"
    );
  });

  it("shows both split columns in the frame whatever its width", () => {
    const previewCss = readFileSync(
      "src/features/auth-admin/components/branding/styles.css",
      "utf8"
    );
    expect(previewCss).not.toMatch(/@container/);
    expect(previewCss).toMatch(
      /\.t-branding-preview-frame \.t-brand-split-with-image \.t-brand-split-image \{\s*display: block;/
    );
  });

  it("follows the draft's layout again once it changes", async () => {
    const { container, rerender } = render(
      <BrandingPreview draft={draft} inherited={inherited} />
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Split" }));
    expect(
      container.querySelector("[data-brand-layout='split']")
    ).not.toBeNull();
    rerender(
      <BrandingPreview
        draft={{ ...draft, layout: "centered" }}
        inherited={inherited}
      />
    );
    expect(
      container.querySelector("[data-brand-layout='centered']")
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Centered" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});
