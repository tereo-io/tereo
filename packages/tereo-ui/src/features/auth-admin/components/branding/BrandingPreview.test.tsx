import type { EffectiveBranding } from "@/features/auth";
import { render, screen } from "@testing-library/react";
import { emptyDraft } from "../../api/branding/types";
import { BrandingPreview } from "./BrandingPreview";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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
          logo: { sha256: "a", url: "https://cdn.example/logo.png" },
        }}
      />
    );
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "https://cdn.example/logo.png"
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Split" }));
    expect(
      container.querySelector("[data-brand-layout='split']")
    ).not.toBeNull();
  });
});
