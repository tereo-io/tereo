import { afterEach, describe, expect, it } from "vitest";
import { useStockColors } from "./useStockColors";
import { render } from "@testing-library/react";

const Probe = () => {
  useStockColors();
  return null;
};

const addStyle = () => {
  const el = document.createElement("style");
  el.id = "tereo-branding-style";
  el.textContent = ":root{--x:red}";
  document.head.appendChild(el);
  return el;
};

afterEach(() => document.getElementById("tereo-branding-style")?.remove());

describe("useStockColors", () => {
  it("disables the branding style while mounted and re-enables it after", () => {
    const style = addStyle();
    const { unmount } = render(<Probe />);
    expect(style.disabled).toBe(true);
    unmount();
    expect(style.disabled).toBe(false);
  });

  it("restores a style that was already disabled", () => {
    const style = addStyle();
    style.disabled = true;
    render(<Probe />).unmount();
    expect(style.disabled).toBe(true);
  });

  it("does nothing without the style element", () => {
    expect(() => render(<Probe />).unmount()).not.toThrow();
  });
});
